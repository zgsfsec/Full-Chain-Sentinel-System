package httpreplay

import (
	"bytes"
	gzip "compress/gzip"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// =============================================================== 解析矩阵

var testFallback = Target{Host: "h.test", Scheme: "http", Port: 80}

func mustParse(t *testing.T, raw string, fallback Target) *Request {
	t.Helper()
	req, err := ParseRequest([]byte(raw), fallback)
	if err != nil {
		t.Fatalf("ParseRequest: %v", err)
	}
	return req
}

func TestT01HeaderOrderCaseRepeat(t *testing.T) {
	raw := "GET / HTTP/1.1\r\nx-a: 1\r\nX-B: 2\r\nx-a: 3\r\n\r\n"
	req := mustParse(t, raw, Target{Host: "h", Scheme: "http", Port: 80})

	want := []Header{{"x-a", "1"}, {"X-B", "2"}, {"x-a", "3"}}
	if len(req.Headers) != 3 {
		t.Fatalf("头部数量 = %d", len(req.Headers))
	}
	for i, w := range want {
		if req.Headers[i] != w {
			t.Errorf("headers[%d] = %+v, want %+v", i, req.Headers[i], w)
		}
	}
}

func TestT02DuplicateCookie(t *testing.T) {
	raw := "GET / HTTP/1.1\r\nCookie: a=1\r\nCookie: b=2\r\n\r\n"
	req := mustParse(t, raw, Target{Host: "h", Scheme: "http", Port: 80})
	if len(req.Headers) != 2 || req.Headers[0].Value != "a=1" || req.Headers[1].Value != "b=2" {
		t.Errorf("重复头被合并: %+v", req.Headers)
	}
}

func TestT03CustomMethod(t *testing.T) {
	req := mustParse(t, "FOO /x HTTP/1.1\r\nHost: h\r\n\r\n", testFallback)
	if req.Method != "FOO" {
		t.Errorf("Method = %q", req.Method)
	}
}

func TestT04NoBlankLine(t *testing.T) {
	req := mustParse(t, "GET / HTTP/1.1\r\nHost: h", testFallback)
	if len(req.Body) != 0 {
		t.Errorf("无空行时 body 应为空, got %q", req.Body)
	}
}

func TestT05ContentLengthMismatch(t *testing.T) {
	raw := "POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 999\r\n\r\nabc"
	req := mustParse(t, raw, Target{})
	found := false
	for _, w := range req.Warnings {
		if w.Code == "cl_mismatch" {
			found = true
		}
	}
	if !found {
		t.Errorf("应产生 cl_mismatch 警告: %+v", req.Warnings)
	}
}

func TestT06ManualChunked(t *testing.T) {
	raw := "POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"
	req := mustParse(t, raw, Target{})
	if !req.HasChunked() {
		t.Error("应识别 chunked")
	}
	if string(req.Body) != "5\r\nhello\r\n0\r\n\r\n" {
		t.Errorf("chunked body 应原样保留: %q", req.Body)
	}
}

func TestT07BareLF(t *testing.T) {
	raw := "GET / HTTP/1.1\nHost: h\nX-Test: lf\n\n"
	req := mustParse(t, raw, Target{})
	if len(req.Headers) != 2 || req.Headers[1].Value != "lf" {
		t.Errorf("裸 LF 解析错误: %+v", req.Headers)
	}
	// 原文保持裸 LF
	if bytes.Contains(req.Raw, []byte("\r\n")) {
		t.Error("Raw 不应被改写为 CRLF")
	}
}

func TestObsFoldAndMalformed(t *testing.T) {
	raw := "GET / HTTP/1.1\r\nX-Long: a\r\n  continued\r\nBroken-Line\r\n\r\n"
	req := mustParse(t, raw, Target{})
	codes := map[string]bool{}
	for _, w := range req.Warnings {
		codes[w.Code] = true
	}
	if !codes["obs_fold"] || !codes["malformed_header"] {
		t.Errorf("应产生 obs_fold 与 malformed_header 警告: %+v", req.Warnings)
	}
	if len(req.Headers) != 1 || req.Headers[0].Value != "a continued" {
		t.Errorf("折行合并错误: %+v", req.Headers)
	}
}

func TestMissingProtoWarning(t *testing.T) {
	req := mustParse(t, "GET /\r\nHost: h\r\n\r\n", Target{Host: "h", Scheme: "http", Port: 80})
	if req.Proto != "HTTP/1.1" {
		t.Errorf("Proto = %q", req.Proto)
	}
	if len(req.Warnings) == 0 || req.Warnings[0].Code != "no_proto" {
		t.Errorf("应产生 no_proto 警告: %+v", req.Warnings)
	}
}

func TestAbsoluteForm(t *testing.T) {
	req := mustParse(t, "GET http://example.com/a?b=1 HTTP/1.1\r\nHost: x\r\n\r\n", testFallback)
	if req.URL.Host != "example.com" || req.URL.Scheme != "http" || req.URL.Port != 80 {
		t.Errorf("URL = %+v", req.URL)
	}
	if req.URL.Path != "/a?b=1" {
		t.Errorf("Path = %q", req.URL.Path)
	}
}

func TestTargetFromRaw(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want Target
		ok   bool
	}{
		{
			name: "origin-form 用 Host 头",
			raw:  "GET /admin HTTP/1.1\r\nHost: 127.0.0.1:7465\r\n\r\n",
			want: Target{Scheme: "http", Host: "127.0.0.1", Port: 7465},
			ok:   true,
		},
		{
			name: "Host 头没有端口按 80",
			raw:  "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n",
			want: Target{Scheme: "http", Host: "example.com", Port: 80},
			ok:   true,
		},
		{
			name: "443 视为 https",
			raw:  "GET / HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
			want: Target{Scheme: "https", Host: "example.com", Port: 443},
			ok:   true,
		},
		{
			name: "absolute-form 请求行优先",
			raw:  "GET https://x.test:8443/p HTTP/1.1\r\nHost: ignored.test\r\n\r\n",
			want: Target{Scheme: "https", Host: "x.test", Port: 8443, Path: "/p"},
			ok:   true,
		},
		{
			name: "CONNECT 自带目标",
			raw:  "CONNECT x.test:443 HTTP/1.1\r\n\r\n",
			want: Target{Scheme: "https", Host: "x.test", Port: 443},
			ok:   true,
		},
		{
			name: "裸 LF 报文也能读出 Host",
			raw:  "GET /a HTTP/1.1\nHost: h.test:8080\n\n",
			want: Target{Scheme: "http", Host: "h.test", Port: 8080},
			ok:   true,
		},
		{
			name: "Host 头大小写不敏感",
			raw:  "GET / HTTP/1.1\r\nhOsT: H.test:8080\r\n\r\n",
			want: Target{Scheme: "http", Host: "H.test", Port: 8080},
			ok:   true,
		},
		{
			name: "IPv6 主机",
			raw:  "GET / HTTP/1.1\r\nHost: [::1]:8080\r\n\r\n",
			want: Target{Scheme: "http", Host: "::1", Port: 8080},
			ok:   true,
		},
		{
			name: "没有 Host 头也无从推断",
			raw:  "GET /admin HTTP/1.1\r\nX-A: 1\r\n\r\n",
			ok:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := TargetFromRaw([]byte(tc.raw))
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if !ok {
				return
			}
			if got != tc.want {
				t.Errorf("target = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestRebuildPreservesLFForm(t *testing.T) {
	raw := []byte("GET / HTTP/1.1\nHost: h\n")
	req := mustParse(t, string(raw), Target{})
	out := Rebuild(req, "h2", "close")
	if !bytes.Contains(out, []byte("Host: h2\n")) || bytes.Contains(out, []byte("\r\n")) {
		t.Errorf("增补行应保持裸 LF 风格: %q", out)
	}
}

func TestParseEmptyFails(t *testing.T) {
	if _, err := ParseRequest([]byte("   \n"), Target{}); err == nil {
		t.Fatal("空请求应报错")
	}
	// 无法解析目标时解析成功，但 URL 为空（Send 阶段报 bad_request）
	req, err := ParseRequest([]byte("GET /\r\n\r\n"), Target{})
	if err != nil {
		t.Fatalf("origin-form 无 fallback 不应阻塞解析: %v", err)
	}
	if req.URL.Host != "" {
		t.Errorf("URL 应为空, got %+v", req.URL)
	}
}

// =============================================================== 发送矩阵

// startRawServer 启动一个"读到静止即回应"的裸 TCP 服务，返回地址与收到的字节 channel。
func startRawServer(t *testing.T, respond func(req []byte) []byte) (string, <-chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	got := make(chan []byte, 1)

	go func() {
		defer close(got)
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()

		var buf bytes.Buffer
		tmp := make([]byte, 4096)
		quiet := 250 * time.Millisecond
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			_ = conn.SetReadDeadline(time.Now().Add(quiet))
			n, err := conn.Read(tmp)
			if n > 0 {
				buf.Write(tmp[:n])
			}
			if err != nil {
				break // 超时即认为请求读取完毕
			}
		}
		got <- buf.Bytes()
		if respond != nil {
			_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
			_, _ = conn.Write(respond(buf.Bytes()))
		}
	}()
	return ln.Addr().String(), got
}

func send(t *testing.T, raw string, mutate func(*Options)) Result {
	t.Helper()
	var opts Options
	if mutate != nil {
		mutate(&opts)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return (&Client{}).Send(ctx, []byte(raw), opts)
}

func TestSendBytesFidelity(t *testing.T) {
	// 自带 Content-Length/Connection 时不产生任何增补 → 字节必须完全一致
	raw := "POST /p?a=1 HTTP/1.1\r\nHost: x.test\r\nx-a: 1\r\nX-B: 2\r\nx-a: 3\r\nContent-Length: 12\r\nConnection: close\r\n\r\nbody-payload"
	addr, got := startRawServer(t, func(req []byte) []byte {
		return []byte("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
	})
	host, port, _ := net.SplitHostPort(addr)
	portN := atoi(port)

	res := send(t, raw, func(o *Options) {
		o.FallbackURL = "http://" + addr
	})
	select {
	case received := <-got:
		if string(received) != raw {
			t.Errorf("线上字节与原文不一致:\n got: %q\nwant: %q", received, raw)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("未收到服务端数据")
	}
	_ = host
	_ = portN

	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if res.Response == nil || res.Response.Status != 204 {
		t.Fatalf("Status = %+v", res.Response)
	}
}

func TestSendAutoHeaders(t *testing.T) {
	raw := "GET / HTTP/1.1\r\nX-Only: 1\r\n\r\n"
	addr, got := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi")
	})
	res := send(t, raw, func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	received := <-got
	s := string(received)
	if !strings.Contains(s, "Host: "+addr) {
		t.Errorf("应自动补 Host，收到: %q", s)
	}
	if !strings.Contains(s, "Connection: close") {
		t.Errorf("应自动补 Connection: close，收到: %q", s)
	}
	if !strings.Contains(s, "X-Only: 1\r\nHost: ") {
		t.Errorf("增补头应在原有头之后: %q", s)
	}
}

func TestSendAutoContentLength(t *testing.T) {
	// 有 body 但缺 CL/TE：必须自动补 Content-Length，否则服务端无法判定边界
	raw := "POST /submit HTTP/1.1\r\nHost: x\r\n\r\nuser=a&pass=b"
	addr, got := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	})
	res := send(t, raw, func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	received := string(<-got)
	if !strings.Contains(received, "Content-Length: 13\r\n") {
		t.Errorf("应自动补 Content-Length: 13, 收到: %q", received)
	}
	if !strings.HasSuffix(received, "\r\n\r\nuser=a&pass=b") {
		t.Errorf("body 应原样在末尾: %q", received)
	}

	// 关闭该行为后不应补 CL（用新的服务端，避免复用已结束的连接）
	addr2, got2 := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	})
	res = send(t, raw, func(o *Options) {
		o.FallbackURL = "http://" + addr2
		o.DisableAutoCL = true
	})
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if received2 := string(<-got2); strings.Contains(received2, "Content-Length") {
		t.Errorf("关闭后不应补 CL: %q", received2)
	}
}

func TestSendChunkedResponse(t *testing.T) {
	addr, _ := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Trailer: t\r\n\r\n" +
			"5\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer-End: 1\r\n\r\n")
	})
	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if string(res.Response.Body) != "hello world" {
		t.Errorf("Body = %q", res.Response.Body)
	}
	if !bytes.Contains(res.Response.Raw, []byte("5\r\nhello")) {
		t.Error("Raw 应保留 chunk 框架")
	}
	found := false
	for _, h := range res.Response.Headers {
		if h.Name == "X-Trailer" {
			found = true
		}
	}
	if !found {
		t.Error("trailer 头应并入 Headers 视图")
	}
}

func TestSendGzipRawPreserved(t *testing.T) {
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write([]byte("compressed-data"))
	_ = w.Close()

	addr, _ := startRawServer(t, func([]byte) []byte {
		return append([]byte("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: "+
			itoa(int64(gz.Len()))+"\r\n\r\n"), gz.Bytes()...)
	})
	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if !bytes.Equal(res.Response.Body, gz.Bytes()) {
		t.Error("引擎不得解压：Body 应等于压缩字节")
	}
	if !bytes.Contains(res.Response.Raw, gz.Bytes()) {
		t.Error("Raw 应包含压缩原文")
	}
}

func TestSendTruncatedBody(t *testing.T) {
	addr, _ := startRawServer(t, func([]byte) []byte {
		// 宣称 100 字节但只发 3 字节后关闭
		return []byte("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc")
	})
	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err == nil || res.Err.Code != "body_incomplete" {
		t.Fatalf("Err = %+v, want body_incomplete", res.Err)
	}
	if !res.Response.Truncated {
		t.Error("应标记 Truncated")
	}
	if string(res.Response.Body) != "abc" {
		t.Errorf("Body = %q, want abc", res.Response.Body)
	}
}

func TestSendSkip1xx(t *testing.T) {
	addr, _ := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	})
	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if res.Response.Status != 200 {
		t.Errorf("Status = %d, want 200（1xx 应被跳过）", res.Response.Status)
	}
	if !bytes.Contains(res.Response.Raw, []byte("100 Continue")) {
		t.Error("Raw 应保留 1xx 原文")
	}
}

func TestSendHeaderTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		conn, aerr := ln.Accept()
		if aerr != nil {
			return
		}
		time.Sleep(3 * time.Second) // 保持打开，制造 header 超时
		_ = conn.Close()
	}()

	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) {
		o.FallbackURL = "http://" + ln.Addr().String()
		o.HeaderTimeout = 400 * time.Millisecond
		o.TotalTimeout = 2 * time.Second
	})
	if res.Err == nil || res.Err.Code != "header_timeout" {
		t.Fatalf("Err = %+v, want header_timeout", res.Err)
	}
}

func TestSendMaxResponseLimit(t *testing.T) {
	big := strings.Repeat("A", 200_000)
	addr, _ := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\n\r\n" + big)
	})
	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) {
		o.FallbackURL = "http://" + addr
		o.MaxResponseBytes = 1024
	})
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if !res.Response.Truncated {
		t.Error("超限应标记 Truncated")
	}
	if int64(len(res.Response.Body)) > 1024 {
		t.Errorf("Body 长度 = %d, 应 ≤ 1024", len(res.Response.Body))
	}
}

func TestSendConnRefused(t *testing.T) {
	// 占一个端口后立刻关闭 → 连接被拒绝
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err == nil || res.Err.Code != "conn_refused" {
		t.Fatalf("Err = %+v, want conn_refused", res.Err)
	}
}

func TestSendTLSSelfSigned(t *testing.T) {
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "method=%s path=%s ua=%q", r.Method, r.URL.Path, r.Header.Get("X-Marker"))
	}))
	defer tlsSrv.Close()

	// 未信任 CA → tls_cert
	res := send(t, "GET /a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", func(o *Options) {
		o.FallbackURL = tlsSrv.URL
	})
	if res.Err == nil || res.Err.Code != "tls_cert" {
		t.Fatalf("Err = %+v, want tls_cert", res.Err)
	}

	// 忽略校验 → 成功
	res = send(t, "GET /a HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Marker: m1\r\n\r\n", func(o *Options) {
		o.FallbackURL = tlsSrv.URL
		o.InsecureTLS = true
	})
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if !strings.Contains(string(res.Response.Body), "method=GET path=/a") {
		t.Errorf("Body = %q", res.Response.Body)
	}
	if res.Timings.TLSMS < 0 {
		t.Error("TLS 耗时应被记录")
	}
}

func TestSendPlainToTLSPort(t *testing.T) {
	// 对明文服务发起 https → TLS 握手失败
	addr, _ := startRawServer(t, func([]byte) []byte { return []byte("HTTP/1.1 200 OK\r\n\r\n") })
	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) {
		o.FallbackURL = "https://" + addr
	})
	if res.Err == nil {
		t.Fatal("应返回错误")
	}
	if res.Err.Code != "tls_handshake" && res.Err.Code != "header_timeout" {
		t.Fatalf("Err = %+v, want tls_handshake", res.Err)
	}
}

func TestSendViaHTTPProxyAbsoluteForm(t *testing.T) {
	addr, got := startRawServer(t, func(req []byte) []byte {
		if bytes.Contains(req, []byte("GET http://target.test/abs HTTP/1.1")) {
			return []byte("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nproxy")
		}
		return []byte("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
	})
	res := send(t, "GET /abs HTTP/1.1\r\nHost: target.test\r\n\r\n", func(o *Options) {
		o.FallbackURL = "http://target.test"
		o.UpstreamProxy = "http://" + addr
	})
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	received := <-got
	if !bytes.Contains(received, []byte("GET http://target.test/abs HTTP/1.1")) {
		t.Errorf("代理模式应使用绝对形式请求行: %q", received)
	}
	if string(res.Response.Body) != "proxy" {
		t.Errorf("Body = %q", res.Response.Body)
	}
}

func TestSendTimingsPopulated(t *testing.T) {
	addr, _ := startRawServer(t, func([]byte) []byte {
		return []byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
	})
	res := send(t, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", func(o *Options) { o.FallbackURL = "http://" + addr })
	if res.Err != nil {
		t.Fatalf("Err = %+v", res.Err)
	}
	if res.Timings.TotalMS < 0 || res.Timings.ConnectMS < 0 {
		t.Errorf("Timings = %+v", res.Timings)
	}
}

// =============================================================== 工具

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return n
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
