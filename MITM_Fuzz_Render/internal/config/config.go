// Package config 负责 replayd 的启动配置：默认值 → 环境变量 → 命令行参数。
//
// 优先级：命令行 > 环境变量 > 默认值。
// token 若未显式提供，则在数据目录生成并复用（0600）。
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	// RandomPortMin / RandomPortMax：未显式指定端口时，每次启动在 7000–8000 里
	// 随机挑一个当前空闲的端口（显式 -listen / 环境变量仍优先）。
	RandomPortMin = 7000
	RandomPortMax = 8000
	// DefaultListenHost 是随机端口绑定的主机：仅回环，避免暴露到局域网。
	DefaultListenHost = "127.0.0.1"
	// DefaultRetentionDays 与 DefaultRetentionCount 共同决定抓包历史的保留上限，先到者为准。
	DefaultRetentionDays  = 30
	DefaultRetentionCount = 50000

	tokenFileName = "token"
	tokenBytes    = 32
)

// Config 是进程的完整启动配置。
type Config struct {
	Listen        string
	ProxyListen   string
	ProxyAuthFile string
	DataDir       string
	Token         string
	LogLevel      string
	LogFormat     string
	OpenBrowser   bool
	NoProxy       bool
	Quiet         bool

	RetentionDays        int
	RetentionCount       int
	ProxySkipStatic      bool
	ProxyMaxCaptureBytes int64

	// 由 main 注入的构建信息。
	Version   string
	Commit    string
	BuildTime string

	// VersionRequested 表示用户只是查询版本（-version），调用方应打印后退出。
	VersionRequested bool

	// TokenGenerated 表示本次启动新生成（而非复用）了 token，便于决定是否高亮提示。
	TokenGenerated bool

	// ListenRandom / ProxyListenRandom 表示端口是本次随机分配的（而非显式指定）。
	ListenRandom      bool
	ProxyListenRandom bool
}

// Load 解析参数与环境变量，并完成数据目录与 token 的初始化。
func Load(args []string) (*Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("config: 无法确定用户主目录: %w", err)
	}

	listenEnv := strings.TrimSpace(os.Getenv("REPLAYD_LISTEN"))
	proxyEnv := strings.TrimSpace(os.Getenv("REPLAYD_PROXY_LISTEN"))
	cfg := &Config{
		Listen:         listenEnv,
		ProxyListen:    proxyEnv,
		DataDir:        envOr("REPLAYD_DATA_DIR", filepath.Join(home, ".replayd")),
		Token:          os.Getenv("REPLAYD_TOKEN"),
		LogLevel:       envOr("REPLAYD_LOG_LEVEL", "info"),
		LogFormat:      envOr("REPLAYD_LOG_FORMAT", "text"),
		OpenBrowser:    envBool("REPLAYD_OPEN_BROWSER"),
		NoProxy:        envBool("REPLAYD_NO_PROXY"),
		Quiet:          envBool("REPLAYD_QUIET"),
		RetentionDays:  envInt("REPLAYD_RETENTION_DAYS", DefaultRetentionDays),
		RetentionCount: envInt("REPLAYD_RETENTION_COUNT", DefaultRetentionCount),
	}

	fs := flag.NewFlagSet("replayd", flag.ContinueOnError)
	fs.StringVar(&cfg.Listen, "listen", cfg.Listen,
		"控制台监听地址（默认在 7000-8000 随机挑一个空闲端口）")
	fs.StringVar(&cfg.ProxyListen, "proxy-listen", cfg.ProxyListen,
		"代理监听地址（默认在 7000-8000 随机挑一个空闲端口）")
	fs.StringVar(&cfg.ProxyAuthFile, "proxy-auth-file", "", "代理认证配置文件（不指定则不启用账号认证）")
	fs.StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "数据目录")
	fs.StringVar(&cfg.Token, "token", cfg.Token, "访问令牌（默认自动生成）")
	fs.StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "日志级别: debug|info|warn|error")
	fs.StringVar(&cfg.LogFormat, "log-format", cfg.LogFormat, "日志格式: text|json")
	fs.BoolVar(&cfg.OpenBrowser, "open", cfg.OpenBrowser, "启动后打开浏览器")
	fs.BoolVar(&cfg.NoProxy, "no-proxy", cfg.NoProxy, "不自动启动 MITM 代理")
	fs.BoolVar(&cfg.Quiet, "quiet", cfg.Quiet, "不打印访问 URL")
	fs.IntVar(&cfg.RetentionDays, "retention-days", cfg.RetentionDays, "抓包保留天数")
	fs.IntVar(&cfg.RetentionCount, "retention-count", cfg.RetentionCount, "抓包保留条数")
	fs.BoolVar(&cfg.ProxySkipStatic, "proxy-skip-static", false, "不保存常见图片、音视频、字体和 CSS 静态流量")
	fs.Int64Var(&cfg.ProxyMaxCaptureBytes, "proxy-max-capture-bytes", 0, "每侧原始报文保存字节上限，超出截断（0 使用原有行为）")
	fs.BoolVar(&cfg.VersionRequested, "version", false, "打印版本后退出")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if cfg.VersionRequested {
		return cfg, nil
	}

	// 未显式指定（命令行与环境变量都没给）→ 每次启动随机挑空闲端口
	if !flagChanged(fs, "listen") && listenEnv == "" {
		port, err := pickFreePort(0)
		if err != nil {
			return nil, err
		}
		cfg.Listen = net.JoinHostPort(DefaultListenHost, strconv.Itoa(port))
		cfg.ListenRandom = true
	}
	if !flagChanged(fs, "proxy-listen") && proxyEnv == "" {
		exclude := 0
		if _, port, err := net.SplitHostPort(cfg.Listen); err == nil {
			exclude, _ = strconv.Atoi(port)
		}
		port, err := pickFreePort(exclude)
		if err != nil {
			return nil, err
		}
		cfg.ProxyListen = net.JoinHostPort(DefaultListenHost, strconv.Itoa(port))
		cfg.ProxyListenRandom = true
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	cfg.DataDir = filepath.Clean(cfg.DataDir)
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("config: 创建数据目录失败: %w", err)
	}

	if cfg.Token == "" {
		tok, generated, err := loadOrCreateToken(cfg.DataDir)
		if err != nil {
			return nil, err
		}
		cfg.Token = tok
		cfg.TokenGenerated = generated
	}
	return cfg, nil
}

func (c *Config) validate() error {
	if _, _, err := net.SplitHostPort(c.Listen); err != nil {
		return fmt.Errorf("config: -listen 不是合法的 host:port: %q", c.Listen)
	}
	if _, _, err := net.SplitHostPort(c.ProxyListen); err != nil {
		return fmt.Errorf("config: -proxy-listen 不是合法的 host:port: %q", c.ProxyListen)
	}
	switch strings.ToLower(c.LogLevel) {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("config: 未知日志级别 %q（可选 debug|info|warn|error）", c.LogLevel)
	}
	switch strings.ToLower(c.LogFormat) {
	case "text", "json":
	default:
		return fmt.Errorf("config: 未知日志格式 %q（可选 text|json）", c.LogFormat)
	}
	if c.RetentionDays < 1 {
		return errors.New("config: -retention-days 必须 ≥ 1")
	}
	if c.RetentionCount < 100 {
		return errors.New("config: -retention-count 必须 ≥ 100")
	}
	if c.ProxyMaxCaptureBytes < 0 || c.ProxyMaxCaptureBytes > 32<<20 {
		return errors.New("config: -proxy-max-capture-bytes 必须为 0–33554432")
	}
	if len(c.Token) > 0 && len(c.Token) < 16 {
		return errors.New("config: 显式指定的 token 至少 16 个字符")
	}
	return nil
}

// loadOrCreateToken 读取或生成数据目录下的 token 文件。
func loadOrCreateToken(dir string) (token string, generated bool, err error) {
	path := filepath.Join(dir, tokenFileName)
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		tok := strings.TrimSpace(string(b))
		if len(tok) >= 16 {
			if info, statErr := os.Stat(path); statErr == nil && info.Mode().Perm()&0o077 != 0 {
				_ = os.Chmod(path, 0o600) // 收紧历史版本遗留的宽松权限
			}
			return tok, false, nil
		}
		// 内容损坏，重新生成。
	case errors.Is(err, os.ErrNotExist):
		// 首次运行。
	default:
		return "", false, fmt.Errorf("config: 读取 token 失败: %w", err)
	}

	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", false, fmt.Errorf("config: 生成 token 失败: %w", err)
	}
	tok := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(tok+"\n"), 0o600); err != nil {
		return "", false, fmt.Errorf("config: 写入 token 失败: %w", err)
	}
	return tok, true, nil
}

// flagChanged 判断某个命令行参数是否被显式传入。
func flagChanged(fs *flag.FlagSet, name string) bool {
	changed := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			changed = true
		}
	})
	return changed
}

// pickFreePort 在 [RandomPortMin, RandomPortMax] 里随机挑一个当前空闲的端口。
// 先探测再使用，存在极小的 TOCTOU 窗口；真被抢占时启动会明确报错。
func pickFreePort(exclude int) (int, error) {
	span := RandomPortMax - RandomPortMin + 1
	for i := 0; i < 50; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(span)))
		if err != nil {
			return 0, fmt.Errorf("config: 生成随机端口失败: %w", err)
		}
		port := RandomPortMin + int(n.Int64())
		if port == exclude {
			continue
		}
		listener, err := net.Listen("tcp", net.JoinHostPort(DefaultListenHost, strconv.Itoa(port)))
		if err != nil {
			continue // 被占用，换一个
		}
		_ = listener.Close()
		return port, nil
	}
	return 0, fmt.Errorf("config: %d-%d 范围内未找到空闲端口", RandomPortMin, RandomPortMax)
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envBool(key string) bool {
	v, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(key)))
	return err == nil && v
}

func envInt(key string, def int) int {
	v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil {
		return def
	}
	return v
}
