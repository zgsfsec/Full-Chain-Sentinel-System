package httpreplay

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/proxy"
)

// Timings 记录各阶段耗时（毫秒）。
type Timings struct {
	ConnectMS int64 `json:"connectMs"`
	TLSMS     int64 `json:"tlsMs"`
	TTFBMS    int64 `json:"ttfbMs"`
	TotalMS   int64 `json:"totalMs"`
}

// Response 是解析后的响应视图；Raw 永远是权威数据。
type Response struct {
	Raw       []byte    `json:"-"`
	RawSize   int64     `json:"-"` // Bytes received, including any bytes omitted from Raw.
	Proto     string    `json:"proto"`
	Status    int       `json:"status"`
	Reason    string    `json:"reason"`
	Headers   []Header  `json:"headers,omitempty"`
	Body      []byte    `json:"-"` // 解 framing 后的 body（未解压）
	Truncated bool      `json:"truncated"`
	Warnings  []Warning `json:"warnings,omitempty"`
}

// Result 是一次重放的完整结果。
type Result struct {
	Request       *Request  `json:"-"`
	Response      *Response `json:"-"`
	Err           *Error    `json:"-"`
	Timings       Timings   `json:"timings"`
	ResponseBytes int64     `json:"-"`
}

const (
	defaultConnectTimeout = 10 * time.Second
	defaultHeaderTimeout  = 30 * time.Second
	defaultTotalTimeout   = 120 * time.Second
	defaultMaxResponse    = 64 << 20 // 64MB
	maxHeaderLine         = 128 << 10
	maxHeaders            = 512
)

// Options 控制一次发送的全部行为；零值即默认值。
type Options struct {
	FallbackURL   string // origin-form 请求行的目标，如 "https://example.com:443"
	InsecureTLS   bool
	SNI           string
	TLSMinVersion string // "1.2" | "1.3" | ""（默认 1.2）

	ConnectTimeout time.Duration
	HeaderTimeout  time.Duration
	TotalTimeout   time.Duration

	UpstreamProxy    string
	Resolve          map[string]string // "host:port" -> "ip:port"
	MaxResponseBytes int64
	// Stream the original response while retaining only bounded previews in memory.
	ResponseWriter io.Writer

	DisableAutoHost  bool // 缺 Host 时不自动补
	DisableAutoClose bool // 缺 Connection 时不自动补 close
	DisableAutoCL    bool // 有 body 但缺 CL/TE 时不自动补 Content-Length
}

func (o *Options) defaults() {
	if o.ConnectTimeout <= 0 {
		o.ConnectTimeout = defaultConnectTimeout
	}
	if o.HeaderTimeout <= 0 {
		o.HeaderTimeout = defaultHeaderTimeout
	}
	if o.TotalTimeout <= 0 {
		o.TotalTimeout = defaultTotalTimeout
	}
	if o.MaxResponseBytes <= 0 {
		o.MaxResponseBytes = defaultMaxResponse
	}
}

// Client 是无状态的重放客户端；一请求一连接。
type Client struct{}

// Send 执行一次重放。引擎错误（DNS/TLS/超时）不会 panic，而是放在 Result.Err。
func (c *Client) Send(ctx context.Context, raw []byte, opts Options) Result {
	opts.defaults()
	start := time.Now()

	var res Result

	fallback := Target{}
	if opts.FallbackURL != "" {
		u, err := parseSimpleURL(opts.FallbackURL)
		if err != nil {
			res.Err = errCode("bad_request", "目标地址不合法: "+err.Error(), false)
			return res
		}
		fallback = u
	}

	req, err := ParseRequest(raw, fallback)
	if err != nil {
		res.Err = errCode("bad_request", "无法解析请求: "+err.Error(), false)
		return res
	}
	res.Request = req

	if req.URL.Host == "" {
		res.Err = errCode("bad_request",
			"请求未包含主机信息，请在界面中填写目标地址（scheme://host:port）", false)
		return res
	}

	out := buildOutgoing(req, opts)
	target := req.URL
	address := hostPort(target)
	if ip, ok := opts.Resolve[address]; ok {
		address = ip
	}

	// ---- 连接（含上游代理）----
	conn, connectMS, perr := c.dial(ctx, address, target, opts)
	if perr != nil {
		res.Err = perr
		res.Timings.TotalMS = msSince(start)
		return res
	}
	defer func() { _ = conn.Close() }()
	res.Timings.ConnectMS = connectMS

	// ---- TLS ----
	if target.Scheme == "https" {
		tlsConn, tlsMS, terr := c.upgradeTLS(ctx, conn, target, opts)
		if terr != nil {
			res.Err = terr
			res.Timings.TotalMS = msSince(start)
			return res
		}
		conn = tlsConn
		res.Timings.TLSMS = tlsMS
	}

	// ---- 写入 ----
	if werr := ctx.Err(); werr != nil {
		res.Err = errCode("canceled", "已取消", true)
		return res
	}
	if viaHTTPProxy, _ := usingHTTPProxy(opts, target); viaHTTPProxy {
		out = absoluteForm(req)
	}
	_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := conn.Write(out); err != nil {
		res.Err = classifyError(err, "write")
		res.Timings.TotalMS = msSince(start)
		return res
	}

	// ---- 读取 ----
	rec := &recorder{r: conn, limit: opts.MaxResponseBytes + (1 << 20), forward: opts.ResponseWriter}
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stopCancel()
	br := bufio.NewReaderSize(rec, 64<<10)

	resp, ttfbMS, rerr := c.readResponse(conn, br, rec, req.Method, opts)
	res.Timings.TTFBMS = ttfbMS
	res.Response = resp
	res.ResponseBytes = rec.size
	if rerr != nil {
		res.Err = rerr
	}
	// bufio may consume a complete response from the same read that failed to
	// forward. Preserve that write failure even when parsing needs no further read.
	if rec.forwardErr != nil {
		res.Err = classifyError(rec.forwardErr, "write")
	}
	res.Timings.TotalMS = msSince(start)
	return res
}

// dial 建立 TCP 连接；UpstreamProxy 非空时经过上游代理。
func (c *Client) dial(ctx context.Context, address string, target Target, opts Options) (net.Conn, int64, *Error) {
	start := time.Now()
	dialer := &net.Dialer{Timeout: opts.ConnectTimeout}

	if opts.UpstreamProxy == "" {
		conn, err := dialer.DialContext(ctx, "tcp", address)
		if err != nil {
			return nil, 0, classifyError(err, "connect")
		}
		return conn, msSince(start), nil
	}

	scheme, pAddr, user, err := parseProxy(opts.UpstreamProxy)
	if err != nil {
		return nil, 0, errCode("bad_request", err.Error(), false)
	}

	switch scheme {
	case "socks5":
		var auth *proxy.Auth
		if user != nil {
			pass, _ := user.Password()
			auth = &proxy.Auth{User: user.Username(), Password: pass}
		}
		d, perr := proxy.SOCKS5("tcp", pAddr, auth, dialer)
		if perr != nil {
			return nil, 0, errCode("upstream_connect", "创建 SOCKS5 拨号器失败: "+perr.Error(), true)
		}
		cd, ok := d.(proxy.ContextDialer)
		if !ok {
			conn, err := d.Dial("tcp", address)
			if err != nil {
				return nil, 0, classifyError(err, "proxy")
			}
			return conn, msSince(start), nil
		}
		conn, err := cd.DialContext(ctx, "tcp", address)
		if err != nil {
			return nil, 0, classifyError(err, "proxy")
		}
		return conn, msSince(start), nil

	default: // http / https 代理
		pConn, err := dialer.DialContext(ctx, "tcp", pAddr)
		if err != nil {
			return nil, 0, classifyError(err, "proxy")
		}
		if target.Scheme == "https" {
			// CONNECT 隧道
			req := "CONNECT " + address + " HTTP/1.1\r\nHost: " + address + "\r\n"
			if ah := proxyAuthHeader(user); ah != "" {
				req += "Proxy-Authorization: " + ah + "\r\n"
			}
			req += "\r\n"
			_ = pConn.SetDeadline(time.Now().Add(opts.ConnectTimeout + opts.HeaderTimeout))
			if _, err := pConn.Write([]byte(req)); err != nil {
				_ = pConn.Close()
				return nil, 0, classifyError(err, "proxy")
			}
			br := bufio.NewReader(pConn)
			status, err := br.ReadString('\n')
			if err != nil {
				_ = pConn.Close()
				return nil, 0, errCode("upstream_connect", "代理无响应: "+err.Error(), true)
			}
			code := parseStatusLine(status)
			if code < 200 || code >= 300 {
				_ = pConn.Close()
				if code == 407 {
					return nil, 0, errCode("upstream_auth", "上游代理认证失败（407）", false)
				}
				return nil, 0, errCode("upstream_connect",
					fmt.Sprintf("代理拒绝建立隧道（HTTP %d）", code), true)
			}
			// 丢弃剩余响应头
			for {
				line, err := br.ReadString('\n')
				if err != nil || line == "\r\n" || line == "\n" {
					break
				}
			}
			_ = pConn.SetDeadline(time.Time{})
			return pConn, msSince(start), nil
		}
		// http over 代理：交给 write 阶段用绝对形式
		_ = pConn.SetDeadline(time.Time{})
		return pConn, msSince(start), nil
	}
}

// usingHTTPProxy 判断是否需要绝对形式请求行（http 明文走 http 代理）。
func usingHTTPProxy(opts Options, target Target) (bool, string) {
	if opts.UpstreamProxy == "" || target.Scheme != "http" {
		return false, ""
	}
	scheme, _, _, err := parseProxy(opts.UpstreamProxy)
	if err != nil {
		return false, ""
	}
	return scheme == "http" || scheme == "https", scheme
}

// upgradeTLS 把 TCP 连接升级为 TLS。
func (c *Client) upgradeTLS(ctx context.Context, conn net.Conn, target Target, opts Options) (net.Conn, int64, *Error) {
	start := time.Now()
	cfg := &tls.Config{
		ServerName:         opts.SNI,
		InsecureSkipVerify: opts.InsecureTLS,
		NextProtos:         []string{"http/1.1"},
	}
	if cfg.ServerName == "" {
		cfg.ServerName = target.Host
	}
	switch opts.TLSMinVersion {
	case "1.2":
		cfg.MinVersion = tls.VersionTLS12
	case "1.3":
		cfg.MinVersion = tls.VersionTLS13
	default:
		cfg.MinVersion = tls.VersionTLS12
	}

	tc := tls.Client(conn, cfg)
	hsCtx, cancel := context.WithTimeout(ctx, opts.ConnectTimeout)
	defer cancel()
	if err := tc.HandshakeContext(hsCtx); err != nil {
		return nil, 0, classifyError(err, "tls")
	}
	return tc, msSince(start), nil
}

// ---------------------------------------------------------------- 响应读取

func (c *Client) readResponse(conn net.Conn, br *bufio.Reader, rec *recorder, method string, opts Options) (*Response, int64, *Error) {
	deadline := time.Now().Add(opts.TotalTimeout)

	// 状态行（含 1xx 跳过）
	_ = conn.SetReadDeadline(minTime(time.Now().Add(opts.HeaderTimeout), deadline))
	ttfbStart := time.Now()
	var proto string
	var status int
	var reason string
	for {
		line, err := readLineCapped(br, maxHeaderLine)
		if err != nil {
			return nil, 0, classifyReadErr(err, "header", line)
		}
		p, s, rsn, ok := parseStatusParts(line)
		if !ok {
			return nil, 0, errCode("protocol", "响应不是合法 HTTP: "+truncate(strings.TrimSpace(line), 80), true)
		}
		proto, status, reason = p, s, rsn
		if status/100 != 1 {
			break
		}
		// 跳过 1xx 的头，继续读下一个状态行
		if _, herr := readHeaderSection(br); herr != nil {
			return nil, 0, herr
		}
	}
	ttfb := time.Since(ttfbStart).Milliseconds()

	headers, herr := readHeaderSection(br)
	if herr != nil {
		return nil, 0, herr
	}

	_ = conn.SetReadDeadline(deadline)

	resp := &Response{Proto: proto, Status: status, Reason: reason, Headers: headers}
	var bodyErr error

	// ---- body ----
	noBody := strings.EqualFold(method, "HEAD") || status == 204 || status == 304
	switch {
	case noBody:
		// 无 body
	case hasChunked(headers):
		body, trunc, warn, readErr := readChunkedBody(br, opts.MaxResponseBytes, opts.ResponseWriter != nil)
		resp.Body = body
		resp.Truncated = trunc
		resp.Warnings = warn
		bodyErr = readErr
	default:
		cl := headerInt(headers, "Content-Length", -1)
		if cl >= 0 {
			keep := min(int64(cl), opts.MaxResponseBytes)
			body := make([]byte, keep)
			n, err := io.ReadFull(br, body)
			resp.Body = body[:n]
			bodyErr = err
			resp.Truncated = int64(cl) > keep || err != nil
			if err == nil && int64(cl) > keep && opts.ResponseWriter != nil {
				_, bodyErr = io.CopyN(io.Discard, br, int64(cl)-keep)
			}
		} else {
			// 读到 EOF
			var buf bytes.Buffer
			n, err := io.Copy(&limitedWriter{w: &buf, limit: opts.MaxResponseBytes}, br)
			resp.Body = buf.Bytes()
			bodyErr = err
			resp.Truncated = n > opts.MaxResponseBytes || err != nil
		}
	}

	if rec.full {
		resp.Truncated = true
	}
	resp.Raw = rec.buf.Bytes()
	resp.RawSize = rec.size
	if bodyErr != nil {
		resp.Truncated = true
		if errors.Is(bodyErr, io.EOF) || errors.Is(bodyErr, io.ErrUnexpectedEOF) {
			return resp, ttfb, errCode("body_incomplete", "响应未完整接收：对端提前关闭连接", false)
		}
		return resp, ttfb, classifyError(bodyErr, "body")
	}
	return resp, ttfb, nil
}

// readHeaderSection 读到空行为止，返回解析后的头。
func readHeaderSection(br *bufio.Reader) ([]Header, *Error) {
	var headers []Header
	for i := 0; i < maxHeaders; i++ {
		line, err := readLineCapped(br, maxHeaderLine)
		if err != nil {
			if errors.Is(err, io.EOF) && strings.TrimSpace(line) == "" {
				return headers, nil // 服务端直接关连接
			}
			return nil, classifyReadErr(err, "header", line)
		}
		t := strings.TrimRight(line, "\r\n")
		if t == "" {
			return headers, nil
		}
		name, value, ok := strings.Cut(t, ":")
		if !ok || strings.TrimSpace(name) == "" {
			continue // 宽容：跳过畸形行
		}
		headers = append(headers, Header{Name: name, Value: strings.TrimLeft(value, " \t")})
	}
	// 头数量超限：继续吞掉剩余头直到空行，但不再记录
	for {
		line, err := readLineCapped(br, maxHeaderLine)
		if err != nil || strings.TrimRight(line, "\r\n") == "" {
			break
		}
	}
	return headers, nil
}

// readLineCapped 读一行；超过 max 的行会被截断并丢弃到行尾。
func readLineCapped(br *bufio.Reader, max int) (string, error) {
	var b strings.Builder
	for {
		chunk, err := br.ReadSlice('\n')
		b.Write(chunk)
		if err == bufio.ErrBufferFull {
			if b.Len() > max {
				// 丢弃到行尾
				for err == bufio.ErrBufferFull {
					chunk, err = br.ReadSlice('\n')
				}
				return b.String() + "\n", nil
			}
			continue
		}
		if err != nil {
			return b.String(), err
		}
		return b.String(), nil
	}
}

func parseStatusParts(line string) (proto string, status int, reason string, ok bool) {
	t := strings.TrimRight(line, "\r\n")
	fields := strings.SplitN(t, " ", 3)
	if len(fields) < 2 {
		return "", 0, "", false
	}
	proto = fields[0]
	s, err := strconv.Atoi(strings.TrimSpace(fields[1]))
	if err != nil {
		return "", 0, "", false
	}
	reason = ""
	if len(fields) == 3 {
		reason = fields[2]
	}
	return proto, s, reason, true
}

func parseStatusLine(line string) int {
	_, s, _, ok := parseStatusParts(line)
	if !ok {
		return 0
	}
	return s
}

func hasChunked(headers []Header) bool {
	for _, h := range headers {
		if strings.EqualFold(h.Name, "Transfer-Encoding") &&
			strings.Contains(strings.ToLower(h.Value), "chunked") {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- 工具类型

// recorder 镜像记录从 socket 读到的原始字节，用于 Response.Raw。
type recorder struct {
	r          io.Reader
	buf        bytes.Buffer
	limit      int64
	full       bool
	size       int64
	forward    io.Writer
	forwardErr error
}

func (rc *recorder) Read(p []byte) (int, error) {
	if rc.forwardErr != nil {
		return 0, rc.forwardErr
	}
	n, err := rc.r.Read(p)
	rc.size += int64(n)
	if n > 0 && !rc.full {
		space := rc.limit - int64(rc.buf.Len())
		if space <= 0 {
			rc.full = true
		} else if int64(n) <= space {
			rc.buf.Write(p[:n])
		} else {
			rc.buf.Write(p[:space])
			rc.full = true
		}
	}
	if n > 0 && rc.forward != nil {
		written, writeErr := rc.forward.Write(p[:n])
		if writeErr != nil {
			rc.forwardErr = writeErr
			return n, writeErr
		}
		if written != n {
			rc.forwardErr = io.ErrShortWrite
			return n, io.ErrShortWrite
		}
	}
	return n, err
}

// limitedWriter 写满 limit 后静默丢弃（配合 Truncated 标记使用）。
type limitedWriter struct {
	w     *bytes.Buffer
	limit int64
}

func (lw *limitedWriter) Write(p []byte) (int, error) {
	space := lw.limit - int64(lw.w.Len())
	if space <= 0 {
		return len(p), nil
	}
	if int64(len(p)) <= space {
		return lw.w.Write(p)
	}
	_, _ = lw.w.Write(p[:space])
	return len(p), nil
}

// ---------------------------------------------------------------- 错误辅助

func classifyReadErr(err error, phase, line string) *Error {
	if errors.Is(err, io.EOF) {
		if strings.TrimSpace(line) == "" {
			return errCode("protocol", "连接被对端关闭（未收到响应）", true)
		}
		return errCode("protocol", "响应被截断: "+truncate(strings.TrimSpace(line), 60), false)
	}
	return classifyError(err, phase)
}

func isTLSVerifyError(err error) bool {
	var cvErr *tls.CertificateVerificationError
	if errors.As(err, &cvErr) {
		return true
	}
	// UnknownAuthority/Hostname/CertificateInvalid 都会被 tls 包装进
	// CertificateVerificationError（它实现了 Unwrap），这里无需逐个匹配。
	return false
}

func isTLSError(err error) bool {
	var tlsErr tls.RecordHeaderError
	if errors.As(err, &tlsErr) {
		return true
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return strings.Contains(strings.ToLower(opErr.Error()), "tls")
	}
	return strings.Contains(strings.ToLower(err.Error()), "tls:")
}

func contextCanceled() error { return context.Canceled }

func errConnRefused() error { return syscall.ECONNREFUSED }

func base64Std(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func msSince(t time.Time) int64 { return time.Since(t).Milliseconds() }
