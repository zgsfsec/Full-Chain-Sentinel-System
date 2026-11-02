package proxy

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/chinaran404/replayd/internal/store"
)

func TestProxyForwards65MiBWithBoundedCapture(t *testing.T) {
	e := newProxyEnv(t)
	e.srv.SetCapturePolicy(false, 1024)
	const length = 65 << 20
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(length))
		block := strings.Repeat("x", 64<<10)
		for sent := 0; sent < length; sent += len(block) {
			if _, err := io.WriteString(w, block); err != nil {
				return
			}
		}
	}))
	defer up.Close()
	resp, err := e.proxiedClient(t).Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	n, err := io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if err != nil || n != length {
		t.Fatalf("large response truncated: bytes=%d err=%v", n, err)
	}
	e.waitCaptured(t, 1)
	flows, _, err := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if err != nil || len(flows) != 1 {
		t.Fatalf("capture missing: %v", err)
	}
	flow, err := e.st.GetFlow(t.Context(), flows[0].ID, true)
	if err != nil || len(flow.RespRaw) != 1024 || flow.RespSize <= length {
		t.Fatalf("capture not bounded/size lost: %v", err)
	}
}

func TestProxyTerminatesEOFDelimitedResponse(t *testing.T) {
	e := newProxyEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		fmt.Fprint(conn, "HTTP/1.0 200 OK\r\n\r\neof-body")
	}))
	defer up.Close()
	client := e.proxiedClient(t)
	client.Timeout = time.Second
	resp, err := client.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || string(body) != "eof-body" {
		t.Fatalf("EOF response hung: %q %v", body, err)
	}
	e.waitCaptured(t, 1)
}
