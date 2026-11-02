package httpreplay

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEmptyKeepAliveResponseCompletesWithoutEOF(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "0")
	}))
	defer up.Close()
	started := time.Now()
	res := send(t, "GET / HTTP/1.1\r\nConnection: keep-alive\r\n\r\n", func(o *Options) {
		o.FallbackURL = up.URL
		o.TotalTimeout = 2 * time.Second
	})
	if res.Err != nil || res.Response == nil || res.Response.Truncated || time.Since(started) > time.Second {
		t.Fatalf("empty response waited for EOF: %+v, elapsed=%s", res, time.Since(started))
	}
}

func TestPartialChunkedResponsePreservesReceivedBody(t *testing.T) {
	for _, body := range []string{"5\r\nabc", "3\r\nabc\r\n", "3\r\nabc\r\n0\r\n"} {
		t.Run(body, func(t *testing.T) {
			addr, _ := startRawServer(t, func([]byte) []byte {
				return []byte("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + body)
			})
			res := send(t, "GET / HTTP/1.1\r\n\r\n", func(o *Options) { o.FallbackURL = "http://" + addr })
			if res.Err == nil || res.Err.Code != "body_incomplete" || string(res.Response.Body) != "abc" || !res.Response.Truncated {
				t.Fatalf("partial chunk lost or accepted: %+v response=%+v", res, res.Response)
			}
		})
	}
}

func TestStreamingForwardsBeyondCaptureLimit(t *testing.T) {
	for _, framing := range []string{"length", "chunked", "eof"} {
		t.Run(framing, func(t *testing.T) {
			body := strings.Repeat("abcdef", 400000)
			wire := "HTTP/1.1 200 OK\r\n"
			switch framing {
			case "length":
				wire += fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(body), body)
			case "chunked":
				wire += fmt.Sprintf("Transfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\n0\r\n\r\n", len(body), body)
			case "eof":
				wire += "\r\n" + body
			}
			addr, _ := startRawServer(t, func([]byte) []byte { return []byte(wire) })
			var forwarded bytes.Buffer
			res := send(t, "GET / HTTP/1.1\r\n\r\n", func(o *Options) {
				o.FallbackURL = "http://" + addr
				o.MaxResponseBytes = 1024
				o.ResponseWriter = &forwarded
			})
			if res.Err != nil || forwarded.String() != wire || len(res.Response.Body) != 1024 || !res.Response.Truncated || res.Response.RawSize != int64(len(wire)) || len(res.Response.Raw) > (1<<20)+1024 {
				t.Fatalf("stream/capture mismatch: err=%v forwarded=%d raw=%d size=%d", res.Err, forwarded.Len(), len(res.Response.Raw), res.Response.RawSize)
			}
		})
	}
}

func TestStreamingDoesNotWaitForCompleteBody(t *testing.T) {
	finish := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "2")
		fmt.Fprint(w, "a")
		w.(http.Flusher).Flush()
		<-finish
		fmt.Fprint(w, "b")
	}))
	defer up.Close()
	defer close(finish)
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	go func() {
		(&Client{}).Send(t.Context(), []byte("GET / HTTP/1.1\r\n\r\n"), Options{FallbackURL: up.URL, ResponseWriter: writer})
		writer.Close()
	}()
	arrived := make(chan error, 1)
	go func() {
		resp, err := http.ReadResponse(bufio.NewReader(reader), nil)
		if err == nil {
			var first [1]byte
			_, err = io.ReadFull(resp.Body, first[:])
			if first[0] != 'a' {
				err = fmt.Errorf("wrong first byte %q", first)
			}
		}
		arrived <- err
	}()
	select {
	case err := <-arrived:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("first byte buffered until end of response")
	}
}

func TestBodyReadCancelsPromptly(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		http.ReadRequest(bufio.NewReader(conn))
		fmt.Fprint(conn, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\na")
		io.Copy(io.Discard, conn)
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	res := (&Client{}).Send(ctx, []byte("GET / HTTP/1.1\r\n\r\n"), Options{FallbackURL: "http://" + ln.Addr().String()})
	if res.Err == nil || time.Since(started) > time.Second {
		t.Fatalf("cancellation ignored: %+v elapsed=%s", res, time.Since(started))
	}
}

func TestStreamingReportsClientWriteFailureEvenWithCompleteBufferedResponse(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
	defer up.Close()
	reader, writer := io.Pipe()
	reader.Close()
	defer writer.Close()
	res := (&Client{}).Send(t.Context(), []byte("GET / HTTP/1.1\r\n\r\n"), Options{FallbackURL: up.URL, ResponseWriter: writer})
	if res.Err == nil {
		t.Fatal("client write failure was silently discarded")
	}
}
