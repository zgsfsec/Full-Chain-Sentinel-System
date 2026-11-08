// replayd 是 Web 发包重放工具的服务端：单二进制内嵌前端，默认仅监听回环。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/chinaran404/replayd/internal/api"
	"github.com/chinaran404/replayd/internal/browser"
	"github.com/chinaran404/replayd/internal/cert"
	"github.com/chinaran404/replayd/internal/config"
	"github.com/chinaran404/replayd/internal/eventbus"
	"github.com/chinaran404/replayd/internal/proxy"
	"github.com/chinaran404/replayd/internal/store"
)

// 由 -ldflags "-X main.version=... -X main.commit=... -X main.buildTime=..." 注入。
var (
	version   = "0.1.0-dev"
	commit    = "none"
	buildTime = "unknown"
)

func main() { os.Exit(run()) }

func run() int {
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintln(os.Stderr, "replayd:", err)
		return 2
	}
	cfg.Version, cfg.Commit, cfg.BuildTime = version, commit, buildTime
	if cfg.VersionRequested {
		fmt.Printf("replayd %s\n  commit:  %s\n  build:   %s\n  go:      %s\n",
			version, commit, buildTime, runtime.Version())
		return 0
	}

	logger := newLogger(cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DataDir)
	if err != nil {
		logger.Error("打开数据库失败", "err", err)
		return 1
	}
	defer func() {
		if err := st.Close(); err != nil {
			logger.Warn("关闭数据库失败", "err", err)
		}
	}()

	caMan, err := cert.Load(filepath.Join(cfg.DataDir, "ca"))
	if err != nil {
		logger.Error("加载本地 CA 失败", "err", err)
		return 1
	}

	bus := eventbus.New()
	px := proxy.New(st, bus, caMan, logger)
	px.SetCapturePolicy(cfg.ProxySkipStatic, cfg.ProxyMaxCaptureBytes)
	px.SetMaxConnections(cfg.ProxyMaxConnections)
	if cfg.ProxyAuthFile != "" {
		if err := px.LoadAuthentication(cfg.ProxyAuthFile); err != nil {
			logger.Error("加载代理认证失败", "err", err)
			return 1
		}
	}
	if !cfg.NoProxy {
		if err := px.Start(cfg.ProxyListen); err != nil {
			logger.Warn("代理自动启动失败（可用 /api/proxy/start 重试）", "err", err)
		}
	}
	srv := api.New(cfg, st, bus, logger, px, caMan)

	// 无头渲染：浏览器按需启动，空闲自动退出；未安装时可由 API 触发下载
	browserManager := browser.New(browser.Options{
		DataDir:     cfg.DataDir,
		Log:         logger,
		IdleTimeout: 5 * time.Minute,
	})
	srv.EnableRender(browserManager)
	defer browserManager.Close()

	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()

	if !cfg.Quiet {
		printStartup(cfg, px, logger)
	}
	if cfg.OpenBrowser {
		go openBrowser(accessURL(cfg))
	}

	select {
	case <-ctx.Done():
		logger.Info("收到退出信号，正在关闭")
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP 服务异常退出", "err", err)
			return 1
		}
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP 服务异常退出", "err", err)
			return 1
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("优雅关闭超时，强制退出", "err", err)
	}
	return 0
}

func printStartup(cfg *config.Config, px *proxy.Server, logger *slog.Logger) {
	banner := "replayd " + cfg.Version
	if cfg.Commit != "" && cfg.Commit != "none" {
		banner += " (" + shortCommit(cfg.Commit) + ")"
	}
	fmt.Println(banner)
	console := accessURL(cfg)
	if cfg.ListenRandom {
		console += "（本次随机分配 7000-8000）"
	}
	fmt.Println("  控制台   " + console)
	fmt.Println("  数据目录 " + cfg.DataDir)
	proxyState := cfg.ProxyListen + "（未启动）"
	if px != nil && px.Status().Running {
		proxyState = px.Status().Listen + "（抓包中）"
	}
	fmt.Println("  代理     " + proxyState)
	if cfg.TokenGenerated {
		fmt.Println("  已生成新令牌，保存在数据目录 token 文件中")
	}
	if !isLoopback(cfg.Listen) {
		logger.Warn("监听地址不在回环网络，局域网内其他设备可访问控制台", "listen", cfg.Listen)
	}
}

// accessURL 返回带 token 的首次访问地址。
func accessURL(cfg *config.Config) string {
	host, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return "http://" + cfg.Listen + "/?token=" + cfg.Token
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/?token=" + cfg.Token
}

func isLoopback(listen string) bool {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func shortCommit(c string) string {
	if len(c) > 7 {
		return c[:7]
	}
	return c
}

func newLogger(level, format string) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lv}
	var h slog.Handler
	if strings.EqualFold(format, "json") {
		h = slog.NewJSONHandler(os.Stderr, opts)
	} else {
		h = slog.NewTextHandler(os.Stderr, opts)
	}
	return slog.New(h)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		slog.Debug("自动打开浏览器失败", "err", err)
	}
}
