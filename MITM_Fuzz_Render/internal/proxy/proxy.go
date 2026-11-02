// Package proxy 实现 MITM 抓包代理。
//
// 结构（docs/PLAN.md §4.2）：
//
//	CONNECT host:443 → 200 → TLS（我们的 leaf，ALPN 仅 h1.1）
//	  → 读客户端请求（增量、保真）→ 复用 httpreplay 引擎发往上游
//	  → 原样回写响应 → 落库 + 广播 flow.new
//
// 保真策略：请求按原始字节转发给引擎；响应把 raw 原样写回客户端。
// 复用引擎意味着上游链路行为（不跟随重定向、错误码等）与 Repeater 完全一致。
package proxy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chinaran404/replayd/internal/cert"
	"github.com/chinaran404/replayd/internal/eventbus"
	"github.com/chinaran404/replayd/internal/httpreplay"
	"github.com/chinaran404/replayd/internal/store"
)

const (
	maxRequestBytes  = 32 << 20
	maxHeadLines     = 512
	maxHeadLineBytes = 128 << 10
	idleTimeout      = 150 * time.Second
	handshakeTimeout = 10 * time.Second
	upstreamTimeout  = 130 * time.Second
)

// Server 是代理实例；用 Start/Stop 控制生命周期。
type Server struct {
	store  *store.Store
	bus    *eventbus.Broker
	ca     *cert.Manager
	client *httpreplay.Client
	log    *slog.Logger

	mu      sync.Mutex
	ln      net.Listener
	addr    string
	running bool

	captured        atomic.Int64
	insecure        atomic.Bool // 上游 TLS 校验开关（测试/自签靶场用）
	skipStatic      atomic.Bool
	maxCaptureBytes atomic.Int64

	bypassMu sync.RWMutex
	bypass   map[string]bool
}

// New 创建代理（不启动）。
func New(st *store.Store, bus *eventbus.Broker, ca *cert.Manager, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	return &Server{
		store:  st,
		bus:    bus,
		ca:     ca,
		client: &httpreplay.Client{},
		log:    log,
		bypass: make(map[string]bool),
	}
}

// Start 在指定地址开始监听并进入接受循环。
func (s *Server) Start(listen string) error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return errors.New("代理已在运行")
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		s.mu.Unlock()
		return fmt.Errorf("代理监听失败: %w", err)
	}
	s.ln = ln
	s.addr = ln.Addr().String()
	s.running = true
	s.mu.Unlock()

	go s.acceptLoop(ln)
	s.bus.Publish("proxy.status", s.Status())
	return nil
}

// Stop 停止监听并断开存量连接（在途请求等待其自然结束）。
func (s *Server) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return errors.New("代理未在运行")
	}
	err := s.ln.Close()
	s.running = false
	s.ln = nil
	s.bus.Publish("proxy.status", s.StatusLocked())
	return err
}

// Status 返回运行状态。
func (s *Server) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.StatusLocked()
}

// StatusLocked 需持有 s.mu。
func (s *Server) StatusLocked() Status {
	return Status{
		Running:  s.running,
		Listen:   s.addr,
		CAReady:  s.ca != nil,
		Captured: s.captured.Load(),
	}
}

// Status 是代理状态的快照。
type Status struct {
	Running  bool   `json:"running"`
	Listen   string `json:"listen"`
	CAReady  bool   `json:"caReady"`
	Captured int64  `json:"captured"`
}

// SetInsecureUpstream 设置是否忽略上游证书校验。
func (s *Server) SetInsecureUpstream(on bool) { s.insecure.Store(on) }

// InsecureUpstream 返回当前上游校验开关。
func (s *Server) InsecureUpstream() bool { return s.insecure.Load() }

// SetBypass 设置 host 直连隧道（不做 MITM）。
func (s *Server) SetBypass(host string, on bool) {
	s.bypassMu.Lock()
	defer s.bypassMu.Unlock()
	if on {
		s.bypass[host] = true
	} else {
		delete(s.bypass, host)
	}
}

// BypassList 返回当前 bypass 列表。
func (s *Server) BypassList() []string {
	s.bypassMu.RLock()
	defer s.bypassMu.RUnlock()
	out := make([]string, 0, len(s.bypass))
	for h := range s.bypass {
		out = append(out, h)
	}
	return out
}

// ---------------------------------------------------------------- 接受循环

func (s *Server) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			s.mu.Lock()
			running := s.running
			s.mu.Unlock()
			if running {
				s.log.Warn("代理接受连接失败", "err", err)
			}
			return
		}
		go s.handleConn(conn)
	}
}

func (s *Server) handleConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	defer func() {
		if rec := recover(); rec != nil {
			s.log.Error("代理连接处理 panic", "panic", rec)
		}
	}()

	_ = conn.SetDeadline(time.Now().Add(idleTimeout))
	br := bufio.NewReaderSize(conn, 64<<10)

	first, err := readLineCapped(br, maxHeadLineBytes)
	if err != nil {
		return
	}
	if strings.HasPrefix(first, "CONNECT ") {
		s.handleConnect(conn, br, first)
		return
	}
	// 明文 HTTP 代理：请求行为绝对形式
	s.relayLoop(conn, br, first, httpreplay.Target{Scheme: "http"})
}

// handleConnect 处理 CONNECT：解密 MITM 或 bypass 隧道。
func (s *Server) handleConnect(conn net.Conn, br *bufio.Reader, requestLine string) {
	hostPort := strings.TrimSpace(strings.TrimPrefix(requestLine, "CONNECT"))
	hostPort, _, _ = strings.Cut(hostPort, " ") // 去掉尾部的 HTTP/1.1
	host, portStr, err := net.SplitHostPort(hostPort)
	if err != nil {
		_, _ = conn.Write([]byte("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"))
		return
	}
	port := 443
	if p, perr := strconv.Atoi(portStr); perr == nil {
		port = p
	}
	// 丢弃 CONNECT 请求的其余头（到空行为止）
	_ = drainHead(br)

	// ---- bypass：盲隧道 ----
	if s.isBypassed(host) {
		_, _ = conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
		s.blindTunnel(conn, host, port, "tunnel(bypass)")
		return
	}

	// ---- MITM ----
	if _, werr := conn.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); werr != nil {
		return
	}
	cfg, cerr := s.ca.TLSConfig(host)
	if cerr != nil {
		s.log.Warn("生成 MITM 证书失败", "host", host, "err", cerr)
		return
	}
	tlsConn := tlsServer(conn, cfg)
	hsCtx, cancel := context.WithTimeout(context.Background(), handshakeTimeout)
	if err := tlsConn.HandshakeContext(hsCtx); err != nil {
		cancel()
		// 最常见原因：客户端不信任我们的 CA（pinning / 未安装）
		s.log.Info("客户端拒绝 MITM 证书", "host", host, "err", err)
		s.recordTunnelFlow(host, port, "tunnel(client-rejected)")
		return
	}
	cancel()
	s.relayLoop(tlsConn, bufio.NewReaderSize(tlsConn, 64<<10), "", httpreplay.Target{
		Scheme: "https", Host: host, Port: port,
	})
}

// relayLoop 在一条（可能已解密的）客户端连接上逐个处理请求。
func (s *Server) relayLoop(client net.Conn, br *bufio.Reader, firstLine string, fallback httpreplay.Target) {
	for i := 0; ; i++ {
		_ = client.SetDeadline(time.Now().Add(idleTimeout))

		line := firstLine
		firstLine = ""
		if line == "" {
			var err error
			line, err = readLineCapped(br, maxHeadLineBytes)
			if err != nil {
				return // EOF / 超时：连接结束
			}
			if strings.TrimSpace(line) == "" {
				continue
			}
		}

		reqRaw, bodyErr := s.readRequest(br, line)
		if bodyErr != nil && len(reqRaw) == 0 {
			return
		}

		req, perr := httpreplay.ParseRequest(reqRaw, fallback)
		if perr != nil {
			_, _ = client.Write([]byte("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"))
			return
		}

		// WebSocket / Upgrade：盲隧道透传
		if _, isUpgrade := httpreplay.HeaderIn(req.Headers, "Upgrade"); isUpgrade && bodyErr == nil {
			s.tunnelUpgrade(client, reqRaw, req)
			return
		}

		// 经引擎发往上游（复用 Repeater 全部语义）
		if req.URL.Host == "" {
			s.writeBadGateway(client, nil)
			return
		}
		opts := httpreplay.Options{
			FallbackURL: req.URL.Scheme + "://" + hostPortOf(req.URL),
			InsecureTLS: s.insecure.Load(),
		}
		ctx, cancel := context.WithTimeout(context.Background(), upstreamTimeout)
		res := s.client.Send(ctx, reqRaw, opts)
		cancel()

		if res.Err != nil {
			s.record(req, res)
			s.writeBadGateway(client, res.Err)
			return // 上游失败后关闭连接，避免状态不同步
		}
		s.record(req, res)
		_ = client.SetWriteDeadline(time.Now().Add(60 * time.Second))
		if _, werr := client.Write(res.Response.Raw); werr != nil {
			return
		}
	}
}

// tunnelUpgrade 处理 WebSocket/Upgrade 请求：原样转发后双向透传。
func (s *Server) tunnelUpgrade(client net.Conn, reqRaw []byte, req *httpreplay.Request) {
	fallback := req.URL
	upConn, err := dialUpstream(fallback, s.insecure.Load())
	if err != nil {
		s.log.Warn("ws 上游连接失败", "target", fallback, "err", err)
		s.writeBadGateway(client, err)
		return
	}
	defer func() { _ = upConn.Close() }()
	_ = upConn.SetDeadline(time.Time{})
	if _, err := upConn.Write(reqRaw); err != nil {
		s.writeBadGateway(client, httpreplay.ClassifyError(err, "connect"))
		return
	}
	s.recordUpgrade(req)
	blindCopy(client, upConn)
}

// blindTunnel 对 bypass 的 CONNECT 只做 TCP 层透传（不做 TLS、不感知内容）。
func (s *Server) blindTunnel(client net.Conn, host string, port int, note string) {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	up, err := dialer.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return
	}
	defer func() { _ = up.Close() }()
	s.recordTunnelFlow(host, port, note)
	blindCopy(client, up)
}

// blindCopy 双向拷贝直到任一侧关闭。
func blindCopy(a, b net.Conn) {
	done := make(chan struct{}, 2)
	copyOne := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		_ = dst.SetDeadline(time.Now())
		done <- struct{}{}
	}
	go copyOne(a, b)
	go copyOne(b, a)
	<-done
}

// ---------------------------------------------------------------- 请求读取

// readRequest 从 br 读取一条完整请求（head + body），返回原始字节。
// bodyErr 非 nil 表示 body 读取不完整（仍返回已读部分）。
func (s *Server) readRequest(br *bufio.Reader, firstLine string) (raw []byte, bodyErr error) {
	var head strings.Builder
	head.WriteString(firstLine)
	if !strings.HasSuffix(firstLine, "\n") {
		head.WriteString("\n") // firstLine 可能来自已被截断的读取
	}

	contentLength := -1
	chunked := false
	sawBlank := false

	for i := 0; i < maxHeadLines; i++ {
		line, err := readLineCapped(br, maxHeadLineBytes)
		if err != nil {
			return []byte(head.String()), err
		}
		if strings.TrimRight(line, "\r\n") == "" {
			sawBlank = true
			head.WriteString(line) // 空行是报文结束符，必须保留（原文可能是 \r\n 或 \n）
			break
		}
		head.WriteString(line)
		name, value, ok := strings.Cut(line, ":")
		if ok {
			n, v := strings.TrimSpace(name), strings.TrimSpace(value)
			if strings.EqualFold(n, "Content-Length") {
				if parsed, perr := strconv.Atoi(v); perr == nil {
					contentLength = parsed
				}
			}
			if strings.EqualFold(n, "Transfer-Encoding") && strings.Contains(strings.ToLower(v), "chunked") {
				chunked = true
			}
			_ = n
		}
	}
	if !sawBlank {
		return []byte(head.String()), errors.New("请求头未正常结束")
	}

	headBytes := []byte(head.String()) // readLineCapped 保留了原始行尾
	if contentLength < 0 && !chunked {
		return headBytes, nil
	}

	var body bytes.Buffer
	if chunked {
		// 保留 chunk 框架原文：读到 0 chunk + 尾部空行为止
		total := int64(0)
		for {
			line, err := readLineCapped(br, maxHeadLineBytes)
			if err != nil {
				return append(headBytes, body.Bytes()...), err
			}
			body.WriteString(line)
			sizeStr, _, _ := strings.Cut(strings.TrimSpace(line), ";")
			size, perr := strconv.ParseInt(sizeStr, 16, 64)
			if perr != nil {
				continue
			}
			if size == 0 {
				// trailers
				for {
					tl, terr := readLineCapped(br, maxHeadLineBytes)
					if terr != nil {
						break
					}
					body.WriteString(tl)
					if strings.TrimRight(tl, "\r\n") == "" {
						break
					}
				}
				break
			}
			total += size
			if total > maxRequestBytes {
				return append(headBytes, body.Bytes()...), errors.New("请求体超限")
			}
			chunk := make([]byte, size+2) // data + CRLF
			if _, err := io.ReadFull(br, chunk); err != nil {
				return append(headBytes, body.Bytes()...), err
			}
			body.Write(chunk)
		}
		return append(headBytes, body.Bytes()...), nil
	}

	// CL
	if contentLength > maxRequestBytes {
		return headBytes, errors.New("请求体超限")
	}
	body.Grow(contentLength)
	chunk := make([]byte, 64<<10)
	for int64(body.Len()) < int64(contentLength) {
		want := int64(contentLength) - int64(body.Len())
		if want > int64(len(chunk)) {
			want = int64(len(chunk))
		}
		n, err := io.ReadFull(br, chunk[:want])
		body.Write(chunk[:n])
		if err != nil {
			return append(headBytes, body.Bytes()...), err
		}
	}
	return append(headBytes, body.Bytes()...), nil
}

func drainHead(br *bufio.Reader) error {
	for i := 0; i < maxHeadLines; i++ {
		line, err := readLineCapped(br, maxHeadLineBytes)
		if err != nil || strings.TrimRight(line, "\r\n") == "" {
			return err
		}
	}
	return nil
}

func readLineCapped(br *bufio.Reader, max int) (string, error) {
	var b strings.Builder
	for {
		chunk, err := br.ReadSlice('\n')
		b.Write(chunk)
		if err == bufio.ErrBufferFull {
			if b.Len() > max {
				for err == bufio.ErrBufferFull {
					chunk, err = br.ReadSlice('\n')
				}
				return b.String(), nil
			}
			continue
		}
		return b.String(), err
	}
}
