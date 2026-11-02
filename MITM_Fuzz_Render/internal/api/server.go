package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/chinaran404/replayd/internal/browser"
	"github.com/chinaran404/replayd/internal/capture"
	"github.com/chinaran404/replayd/internal/cert"
	"github.com/chinaran404/replayd/internal/config"
	"github.com/chinaran404/replayd/internal/eventbus"
	"github.com/chinaran404/replayd/internal/evidence"
	"github.com/chinaran404/replayd/internal/httpreplay"
	"github.com/chinaran404/replayd/internal/proxy"
	"github.com/chinaran404/replayd/internal/render"
	"github.com/chinaran404/replayd/internal/script"
	"github.com/chinaran404/replayd/internal/store"
)

// Server 组装路由、鉴权与静态资源。
type Server struct {
	cfg      *config.Config
	store    *store.Store
	bus      *eventbus.Broker
	replay   httpreplay.Client
	script   *script.Engine
	evidence *evidence.Cache

	browser *browser.Manager
	render  *render.Renderer
	capture *capture.Capturer
	jobs    *jobRegistry
	proxy   *proxy.Server
	ca      *cert.Manager
	log     *slog.Logger
	started time.Time
	limiter *loginLimiter
	router  http.Handler
}

// New 创建 API 服务。
func New(cfg *config.Config, st *store.Store, bus *eventbus.Broker, log *slog.Logger, px *proxy.Server, ca *cert.Manager) *Server {
	if log == nil {
		log = slog.Default()
	}
	s := &Server{
		cfg:      cfg,
		store:    st,
		bus:      bus,
		proxy:    px,
		ca:       ca,
		log:      log,
		started:  time.Now(),
		limiter:  newLoginLimiter(),
		replay:   httpreplay.Client{},
		script:   script.New(),
		evidence: evidence.NewCache(16, 10*time.Minute),
		jobs:     newJobRegistry(),
	}
	s.router = s.routes()
	return s
}

// Handler 返回根 http.Handler。
func (s *Server) Handler() http.Handler { return s.router }

// EnableRender 打开无头渲染能力（main 传入浏览器管理器）。
// 未启用时渲染相关端点返回 501，其余功能不受影响。
func (s *Server) EnableRender(manager *browser.Manager) {
	s.browser = manager
	if manager != nil {
		s.render = render.New(manager, s.log)
		// 界面截图：无头浏览器打开 replayd 自己的 Repeater 页并截图
		s.capture = capture.New(manager, s.log,
			func() string { return capture.SelfURL(s.cfg.Listen) },
			func() string { return s.cfg.Token })
	}
}

// Broker 暴露事件总线（main 用于后续接入代理事件）。
func (s *Server) Broker() *eventbus.Broker { return s.bus }

func (s *Server) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(s.recoverPanic)
	r.Use(s.logRequests)

	// MCP over HTTP：Agent 用 POST /mcp 完成握手与工具调用
	r.Group(func(mr chi.Router) {
		mr.Use(s.authenticate)
		mr.Post("/mcp", s.handleMCP)
		mr.Get("/mcp", s.handleMCP)
	})

	r.Route("/api", func(api chi.Router) {
		// 公共端点：容器健康检查、规格获取、会话建立。
		api.Get("/health", s.handleHealth)
		api.Get("/openapi.json", s.handleOpenAPI)
		api.Get("/session", s.handleSessionState)
		api.Post("/session", s.handleSessionCreate)
		api.Delete("/session", s.handleSessionDelete)

		// 受保护端点。
		api.Group(func(pr chi.Router) {
			pr.Use(s.authenticate)

			pr.Get("/flows", s.handleListFlows)
			pr.Get("/flows/{id}", s.handleGetFlow)
			pr.Delete("/flows/{id}", s.handleDeleteFlow)
			pr.Get("/flows/{id}/raw", s.handleFlowRaw)

			pr.Post("/replay", s.handleReplay)
			pr.Post("/import", s.handleImport)

			pr.Get("/evidence", s.handleEvidence)
			pr.Get("/evidence/sources", s.handleEvidenceSources)
			pr.Get("/evidence/snapshot/{id}", s.handleEvidenceSnapshot)

			pr.Get("/mcp", s.handleMCPInfo)
			pr.Post("/capture", s.handleCapture)

			pr.Post("/render", s.handleRender)
			pr.Get("/render/status", s.handleRenderStatus)
			pr.Get("/render/jobs", s.handleRenderJobs)
			pr.Get("/render/jobs/{id}", s.handleRenderJob)
			pr.Post("/render/browser/install", s.handleBrowserInstall)

			pr.Get("/artifacts", s.handleListArtifacts)
			pr.Get("/artifacts/{id}", s.handleGetArtifact)
			pr.Delete("/artifacts/{id}", s.handleDeleteArtifact)

			pr.Get("/scripts", s.handleListScripts)
			pr.Post("/scripts", s.handleCreateScript)
			pr.Get("/scripts/{id}", s.handleGetScript)
			pr.Put("/scripts/{id}", s.handleUpdateScript)
			pr.Delete("/scripts/{id}", s.handleDeleteScript)
			pr.Post("/scripts/{id}/test", s.handleScriptTest)
			pr.Get("/scripts/{id}/runs", s.handleListScriptRuns)

			pr.Get("/tabs", s.handleListTabs)
			pr.Post("/tabs", s.handleCreateTab)
			pr.Get("/tabs/{id}", s.handleGetTab)
			pr.Patch("/tabs/{id}", s.handlePatchTab)
			pr.Delete("/tabs/{id}", s.handleDeleteTab)
			pr.Put("/tabs/{id}/highlights", s.handlePutTabHighlights)

			pr.Get("/proxy", s.handleProxyStatus)
			pr.Post("/proxy/flows/delete", s.handleProxyDeleteFlows)
			pr.Post("/proxy/start", s.handleProxyStart)
			pr.Post("/proxy/stop", s.handleProxyStop)
			pr.Post("/proxy/insecure", s.handleProxyInsecure)
			pr.Post("/proxy/bypass", s.handleProxyBypass)
			pr.Post("/proxy/ca/regenerate", s.handleProxyRegenerate)
			pr.Get("/proxy/ca.pem", s.handleProxyCAPEM)
			pr.Get("/proxy/ca.crt", s.handleProxyCACRT)
			pr.Get("/proxy/ca.mobileconfig", s.handleProxyCAMobileconfig)
			pr.Get("/proxy/diagnose", s.handleProxyDiagnose)

			pr.Get("/events", s.handleEvents)
		})
	})

	r.NotFound(s.handleStatic)
	return r
}

// ---------------------------------------------------------------- middleware

func (s *Server) recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.log.Error("panic", "panic", rec, "path", r.URL.Path,
					"method", r.Method, "request_id", middleware.GetReqID(r.Context()))
				s.writeError(w, http.StatusInternalServerError, "internal", "服务内部错误", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

// Flush / Hijack / Unwrap 透传，保证 WebSocket 与流式响应可用。
func (w *statusRecorder) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := w.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		status := rec.status
		if status == 0 {
			status = http.StatusOK
		}
		level := slog.LevelInfo
		if status >= 500 {
			level = slog.LevelWarn
		}
		s.log.Log(r.Context(), level, "http",
			"method", r.Method, "path", r.URL.Path, "status", status,
			"bytes", rec.bytes, "duration_ms", time.Since(start).Milliseconds(),
			"request_id", middleware.GetReqID(r.Context()))
	})
}

// ---------------------------------------------------------------- health

type proxyHealthView struct {
	Running bool   `json:"running"`
	Listen  string `json:"listen"`
	CAReady bool   `json:"caReady"`
}

func (s *Server) proxyHealth() proxyHealthView {
	out := proxyHealthView{Listen: s.cfg.ProxyListen, CAReady: s.ca != nil}
	if s.proxy != nil {
		out.Running = s.proxy.Status().Running
		if l := s.proxy.Status().Listen; l != "" {
			out.Listen = l
		}
	}
	return out
}

type healthResponse struct {
	Status       string          `json:"status"`
	Version      string          `json:"version"`
	Commit       string          `json:"commit"`
	BuildTime    string          `json:"buildTime"`
	OS           string          `json:"os"`
	Arch         string          `json:"arch"`
	Listen       string          `json:"listen"`
	DataDir      string          `json:"dataDir"`
	UptimeMS     int64           `json:"uptimeMs"`
	AuthRequired bool            `json:"authRequired"`
	FlowCount    int64           `json:"flowCount"`
	Database     string          `json:"database"`
	Proxy        proxyHealthView `json:"proxy"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	dbStatus := "ok"
	if err := s.store.Ping(ctx); err != nil {
		dbStatus = "error"
	}
	var flowCount int64
	if n, err := s.store.CountAllFlows(ctx); err == nil {
		flowCount = n
	}
	status := "ok"
	if dbStatus != "ok" {
		status = "degraded"
	}

	s.writeJSON(w, http.StatusOK, healthResponse{
		Status:       status,
		Version:      s.cfg.Version,
		Commit:       s.cfg.Commit,
		BuildTime:    s.cfg.BuildTime,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		Listen:       s.cfg.Listen,
		DataDir:      s.cfg.DataDir,
		UptimeMS:     time.Since(s.started).Milliseconds(),
		AuthRequired: true,
		FlowCount:    flowCount,
		Database:     dbStatus,
		Proxy:        s.proxyHealth(),
	})
}

// ---------------------------------------------------------------- helpers

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail,omitempty"`
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		s.log.Debug("写响应失败", "err", err)
	}
}

func (s *Server) writeError(w http.ResponseWriter, status int, code, msg string, detail any) {
	s.writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: msg, Detail: detail}})
}

func (s *Server) notImplemented(msg string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.writeError(w, http.StatusNotImplemented, "unsupported", msg, nil)
	}
}

// decodeJSONBody 读取并解析 JSON 请求体，限制 8MB；空请求体视为合法（保持零值）。
func decodeJSONBody(r *http.Request, dst any) error {
	defer func() { _ = r.Body.Close() }()
	body := io.LimitReader(r.Body, 8<<20)
	err := json.NewDecoder(body).Decode(dst)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func isAPIPath(p string) bool {
	return p == "/api" || strings.HasPrefix(p, "/api/")
}
