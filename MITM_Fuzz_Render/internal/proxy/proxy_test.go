package proxy

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chinaran404/replayd/internal/cert"
	"github.com/chinaran404/replayd/internal/eventbus"
	"github.com/chinaran404/replayd/internal/store"
)

type stderrWriter struct{}

func (stderrWriter) Write(p []byte) (int, error) { return os.Stderr.Write(p) }

type proxyEnv struct {
	srv  *Server
	st   *store.Store
	ca   *cert.Manager
	addr string
}

func newProxyEnv(t *testing.T) *proxyEnv {
	t.Helper()
	st, err := store.Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	ca, err := cert.Load(t.TempDir())
	if err != nil {
		t.Fatalf("cert: %v", err)
	}
	srv := New(st, eventbus.New(), ca, slog.New(slog.NewTextHandler(stderrWriter{}, nil)))
	if err := srv.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = srv.Stop(); _ = st.Close() })
	return &proxyEnv{srv: srv, st: st, ca: ca, addr: srv.Status().Listen}
}

// proxiedClient 模拟"已安装我们 CA"的浏览器：经代理、信任我们的根证书。
func (e *proxyEnv) proxiedClient(t *testing.T) *http.Client {
	t.Helper()
	return &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			Proxy:           func(*http.Request) (*url.URL, error) { return url.Parse("http://" + e.addr) },
			TLSClientConfig: &tls.Config{RootCAs: e.ca.Pool()},
		},
	}
}

func TestMITMCapturesHTTPS(t *testing.T) {
	e := newProxyEnv(t)
	e.srv.SetInsecureUpstream(true) // httptest 自签证书，系统池不信任

	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		fmt.Fprint(w, "hello-mitm")
	}))
	defer up.Close()

	resp, err := e.proxiedClient(t).Get(up.URL + "/sec?a=1")
	if err != nil {
		t.Fatalf("经代理请求失败: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(body) != "hello-mitm" {
		t.Fatalf("body = %q", body)
	}

	// 抓包落库
	e.waitCaptured(t, 1)
	flows, _, err := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if err != nil {
		t.Fatal(err)
	}
	if len(flows) == 0 {
		t.Fatal("应记录 proxy flow")
	}
	f, err := e.st.GetFlow(t.Context(), flows[0].ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if f.Method != "GET" || f.Scheme != "https" || f.Status == nil || *f.Status != 200 {
		t.Errorf("flow 元数据: %+v", f)
	}
	if f.Path != "/sec" || f.Query != "a=1" {
		t.Errorf("path/query = %q / %q", f.Path, f.Query)
	}
	if !bytes.Contains(f.ReqRaw, []byte("GET /sec?a=1 HTTP/1.1")) {
		t.Errorf("ReqRaw = %q", f.ReqRaw)
	}
	if !bytes.Contains(f.RespRaw, []byte("hello-mitm")) {
		t.Error("RespRaw 应包含明文响应")
	}
	if e.srv.captured.Load() == 0 {
		t.Error("captured 计数应增加")
	}
	if !e.srv.Status().Running {
		t.Error("Status 应为 running")
	}
}

func TestPlainHTTPCaptured(t *testing.T) {
	e := newProxyEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "plain-ok")
	}))
	defer up.Close()

	resp, err := e.proxiedClient(t).Get(up.URL + "/p")
	if err != nil {
		t.Fatalf("经代理请求失败: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	e.waitCaptured(t, 1)
	flows, _, _ := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if len(flows) == 0 {
		t.Fatal("应记录明文代理 flow")
	}
	if flows[0].Scheme != "http" {
		t.Errorf("Scheme = %s", flows[0].Scheme)
	}
}

func TestKeepAliveMultipleRequests(t *testing.T) {
	e := newProxyEnv(t)
	e.srv.SetInsecureUpstream(true)
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "n-%s", r.URL.Path)
	}))
	defer up.Close()

	client := e.proxiedClient(t)
	for i := 0; i < 3; i++ {
		resp, err := client.Get(up.URL + fmt.Sprintf("/r%d", i))
		if err != nil {
			t.Fatalf("请求 #%d: %v", i, err)
		}
		_ = resp.Body.Close()
	}
	e.waitCaptured(t, 3)
	flows, _, _ := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if len(flows) < 3 {
		t.Errorf("应记录 ≥3 条 flow, got %d", len(flows))
	}
}

func TestBypassTunnel(t *testing.T) {
	e := newProxyEnv(t)
	e.srv.SetBypass("127.0.0.1", true)

	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "bypassed")
	}))
	defer up.Close()

	// bypass 后客户端直接与上游握手 → 需要信任上游自己的证书
	pool := x509.NewCertPool()
	pool.AddCert(up.Certificate())
	client := &http.Client{Transport: &http.Transport{
		Proxy:           func(*http.Request) (*url.URL, error) { return url.Parse("http://" + e.addr) },
		TLSClientConfig: &tls.Config{RootCAs: pool},
	}}

	resp, err := client.Get(up.URL + "/b")
	if err != nil {
		t.Fatalf("bypass 请求失败: %v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(b) != "bypassed" {
		t.Errorf("body = %q", b)
	}

	// 只应有 CONNECT 隧道记录，不应有解密后的请求 flow
	flows, _, _ := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if len(flows) != 1 || flows[0].Method != "CONNECT" {
		t.Errorf("bypass 应只记录隧道: %+v", flows)
	}
}

func TestBadGatewayOnRefused(t *testing.T) {
	e := newProxyEnv(t)

	// 占端口后关闭 → 上游拒绝
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	resp, err := e.proxiedClient(t).Get("http://" + addr + "/x")
	if err != nil {
		t.Fatalf("应收到 502 而非客户端错误: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	if resp.Header.Get("X-Replayd-Error") == "" {
		t.Error("应带 X-Replayd-Error 头")
	}

	flows, _, _ := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if len(flows) != 1 {
		t.Fatalf("应记录失败 flow, got %d", len(flows))
	}
	f, _ := e.st.GetFlow(t.Context(), flows[0].ID, false)
	if f.Error == nil {
		t.Fatal("flow 应带 error")
	}
	var e2 struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(f.Error, &e2); err != nil || e2.Code == "" {
		t.Errorf("error JSON = %s", f.Error)
	}
}

func TestWebSocketPassthrough(t *testing.T) {
	e := newProxyEnv(t)
	e.srv.SetInsecureUpstream(true)

	// 上游：收到 Upgrade 就 101 并回显后续字节
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Error("无法 hijack")
			return
		}
		conn, buf, _ := hj.Hijack()
		defer func() { _ = conn.Close() }()
		_, _ = conn.Write([]byte("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"))
		msg, err := buf.ReadString('\n')
		if err != nil {
			return
		}
		_, _ = conn.Write([]byte("echo:" + msg))
	}))
	defer up.Close()

	host := strings.TrimPrefix(up.URL, "https://")

	// 手工走 CONNECT + TLS + Upgrade
	conn, err := net.Dial("tcp", e.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	_, _ = conn.Write([]byte("CONNECT " + host + " HTTP/1.1\r\nHost: " + host + "\r\n\r\n"))
	br := bufio.NewReader(conn)
	line, _ := br.ReadString('\n')
	if !strings.Contains(line, "200") {
		t.Fatalf("CONNECT 响应: %s", line)
	}
	drainConn(br)

	tc := tls.Client(conn, &tls.Config{RootCAs: e.ca.Pool(), ServerName: "127.0.0.1"})
	if err := tc.Handshake(); err != nil {
		t.Fatalf("TLS 握手: %v", err)
	}
	tbr := bufio.NewReader(tc) // 握手后必须从 TLS 层读取
	_, _ = tc.Write([]byte("GET /ws HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"))
	line2, err := tbr.ReadString('\n')
	if err != nil || !strings.Contains(line2, "101") {
		t.Fatalf("升级响应: %q %v", line2, err)
	}
	_, _ = tc.Write([]byte("hi-ws\n"))
	// 消费 101 的剩余头（tbr 已缓冲），再读回显
	for {
		hl, herr := tbr.ReadString('\n')
		if herr != nil || hl == "\r\n" {
			break
		}
	}
	_ = tc.SetReadDeadline(time.Now().Add(3 * time.Second))
	echo, rerr := tbr.ReadString('\n')
	if rerr != nil || !strings.Contains(echo, "echo:hi-ws") {
		t.Fatalf("回显 = %q err=%v", echo, rerr)
	}

	// flow 标记 websocket
	flows, _, _ := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	found := false
	for _, f := range flows {
		got, _ := e.st.GetFlow(t.Context(), f.ID, false)
		if got.Note == "websocket" {
			found = true
		}
	}
	if !found {
		t.Error("应记录 websocket flow")
	}
}

func TestStartStopAndDoubleStart(t *testing.T) {
	e := newProxyEnv(t)
	if err := e.srv.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := e.srv.Stop(); err == nil {
		t.Error("重复 Stop 应报错")
	}
	if e.srv.Status().Running {
		t.Error("应为 stopped")
	}
	if err := e.srv.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("重启: %v", err)
	}
}

func drainConn(br *bufio.Reader) {
	for {
		line, err := br.ReadString('\n')
		if err != nil || line == "\r\n" {
			return
		}
	}
}

// Forwarding now streams before persistence, so clients may finish reading first.
func (e *proxyEnv) waitCaptured(t *testing.T, count int64) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if e.srv.captured.Load() >= count {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("capture did not finish: got %d want %d", e.srv.captured.Load(), count)
}
