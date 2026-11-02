package proxy

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/chinaran404/replayd/internal/httpreplay"
	"github.com/chinaran404/replayd/internal/store"
)

func (s *Server) isBypassed(host string) bool {
	s.bypassMu.RLock()
	defer s.bypassMu.RUnlock()
	return s.bypass[host]
}

func tlsServer(conn net.Conn, cfg *tls.Config) *tls.Conn {
	return tls.Server(conn, cfg)
}

// dialUpstream 建立到目标的上游连接（https 时做证书校验的 TLS 握手）。
func dialUpstream(t httpreplay.Target, insecure bool) (net.Conn, *httpreplay.Error) {
	address := net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(context.Background(), "tcp", address)
	if err != nil {
		return nil, httpreplay.ClassifyError(err, "connect")
	}
	if t.Scheme != "https" {
		return conn, nil
	}
	tc := tls.Client(conn, &tls.Config{
		ServerName:         t.Host,
		NextProtos:         []string{"http/1.1"},
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: insecure,
	})
	hsCtx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	defer cancel()
	if err := tc.HandshakeContext(hsCtx); err != nil {
		_ = conn.Close()
		return nil, httpreplay.ClassifyError(err, "tls")
	}
	return tc, nil
}

func hostPortOf(t httpreplay.Target) string {
	defaultPort := (t.Scheme == "http" && t.Port == 80) || (t.Scheme == "https" && t.Port == 443)
	if defaultPort {
		return t.Host
	}
	return net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
}

func (s *Server) writeBadGateway(client net.Conn, e *httpreplay.Error) {
	msg := "上游请求失败"
	detail := ""
	if e != nil {
		msg = e.Message
		detail = e.Code
	}
	body := fmt.Sprintf(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>replayd · 502</title><body style="font-family:monospace;background:#0b0f14;color:#e5e7eb;padding:40px">
<h2>上游请求失败（replayd MITM）</h2><p>%s</p><p style="color:#94a3b8">%s</p></body></html>`, msg, detail)
	head := fmt.Sprintf("HTTP/1.1 502 Bad Gateway\r\n"+
		"Content-Type: text/html; charset=utf-8\r\n"+
		"Content-Length: %d\r\n"+
		"Connection: close\r\n"+
		"X-Replayd-Error: %s\r\n\r\n", len(body), detail)
	_ = client.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, _ = client.Write([]byte(head + body))
}

// ---------------------------------------------------------------- 落库与广播

func (s *Server) record(req *httpreplay.Request, res httpreplay.Result) {
	f := &store.Flow{
		Source:      "proxy",
		Method:      req.Method,
		Scheme:      req.URL.Scheme,
		Host:        req.URL.Host,
		Port:        req.URL.Port,
		HTTPVersion: req.Proto,
		ReqHeaders:  convHeaders(req.Headers),
		ReqRaw:      req.Raw,
		ReqBody:     req.Body,
	}
	if i := indexByte(req.URL.Path, '?'); i >= 0 {
		f.Path, f.Query = req.URL.Path[:i], req.URL.Path[i+1:]
	} else {
		f.Path = req.URL.Path
	}
	if res.Response != nil {
		status := res.Response.Status
		f.Status = &status
		f.RespHeaders = convHeaders(res.Response.Headers)
		f.RespRaw = res.Response.Raw
		f.RespBody = res.Response.Body
		f.RespSize = int64(len(res.Response.Raw))
	}
	if res.Err != nil {
		b, _ := json.Marshal(res.Err)
		f.Error = b
	}
	tj, _ := json.Marshal(res.Timings)
	f.Timings = tj
	d := res.Timings.TotalMS
	f.DurationMS = &d
	s.saveFlow(f, map[string]any{
		"id": f.ID, "source": "proxy", "method": f.Method, "scheme": f.Scheme,
		"host": f.Host, "port": f.Port, "path": f.Path, "status": f.Status,
		"ts": f.TS, "durationMs": f.DurationMS, "error": res.Err != nil,
	})
}

func (s *Server) recordTunnelFlow(host string, port int, note string) {
	f := &store.Flow{
		Source: "proxy", Method: "CONNECT", Scheme: "https",
		Host: host, Port: port, Path: "", Note: note,
	}
	s.saveFlow(f, map[string]any{
		"id": f.ID, "source": "proxy", "method": "CONNECT",
		"host": host, "port": port, "tunnel": true,
	})
}

func (s *Server) recordUpgrade(req *httpreplay.Request) {
	f := &store.Flow{
		Source: "proxy", Method: req.Method, Scheme: req.URL.Scheme,
		Host: req.URL.Host, Port: req.URL.Port, Path: req.URL.Path,
		ReqHeaders: convHeaders(req.Headers), ReqRaw: req.Raw, Note: "websocket",
	}
	if i := indexByte(req.URL.Path, '?'); i >= 0 {
		f.Path, f.Query = req.URL.Path[:i], req.URL.Path[i+1:]
	}
	s.saveFlow(f, map[string]any{
		"id": f.ID, "source": "proxy", "method": f.Method,
		"host": f.Host, "port": f.Port, "path": f.Path, "websocket": true,
	})
}

func (s *Server) saveFlow(f *store.Flow, event map[string]any) {
	if !s.prepareCapture(f) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.store.InsertFlow(ctx, f); err != nil {
		s.log.Warn("代理抓包落库失败", "err", err)
		return
	}
	s.captured.Add(1)
	s.bus.Publish("flow.new", event)
}

func convHeaders(hs []httpreplay.Header) []store.Header {
	if hs == nil {
		return nil
	}
	out := make([]store.Header, len(hs))
	for i, h := range hs {
		out[i] = store.Header{N: h.Name, V: h.Value}
	}
	return out
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
