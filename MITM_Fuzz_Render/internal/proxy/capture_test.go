package proxy

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chinaran404/replayd/internal/store"
)

func TestCapturePolicyFiltersBeforeStorageAndKeepsForwarding(t *testing.T) {
	e := newProxyEnv(t)
	e.srv.SetCapturePolicy(true, 1024)
	payload := strings.Repeat("x", 4096)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/image" {
			w.Header().Set("Content-Type", "image/jpeg")
		}
		fmt.Fprint(w, payload)
	}))
	defer up.Close()
	client := e.proxiedClient(t)
	for _, path := range []string{"/banner.JPG?cache=1", "/video.mp4", "/image", "/api/data", "/app.js", "/icon.svg"} {
		resp, err := client.Get(up.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil || string(body) != payload {
			t.Fatalf("forwarding %s changed: len=%d err=%v", path, len(body), err)
		}
	}
	flows, _, err := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if err != nil || len(flows) != 3 || !e.srv.Status().Running {
		t.Fatalf("live capture: count=%d err=%v", len(flows), err)
	}
	for _, row := range flows {
		f, err := e.st.GetFlow(t.Context(), row.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(f.RespRaw) != 1024 || f.RespSize <= 4096 || len(f.RespBody) != 0 || !strings.Contains(f.Note, "capture-truncated(response") {
			t.Fatalf("capture not bounded: raw=%d original=%d body=%d note=%s", len(f.RespRaw), f.RespSize, len(f.RespBody), f.Note)
		}
	}
	// Switching the filter off must allow the same static URL to be captured.
	e.srv.SetCapturePolicy(false, 1024)
	resp, err := client.Get(up.URL + "/banner.jpg")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	count, err := e.st.CountFlows(t.Context(), store.Filter{Source: "proxy"})
	if err != nil || count != 4 {
		t.Fatalf("filter off: count=%d err=%v", count, err)
	}
}

func TestCaptureLimitPreservesRequestBytesAndSecurityRelevantTraffic(t *testing.T) {
	s := &Server{}
	s.SetCapturePolicy(true, 128)
	status := 200
	for _, test := range []struct {
		method, path, contentType string
		status                    int
	}{
		{"POST", "/upload.jpg", "image/jpeg", 200},
		{"GET", "/missing.jpg", "image/jpeg", 404},
		{"GET", "/assets/app.js", "application/javascript", 200},
		{"GET", "/assets/icon.svg", "image/svg+xml", 200},
		{"GET", "/assets/app.js.map", "application/json", 200},
		{"GET", "/dynamic.jpg", "application/json", 200},
		{"GET", "/dynamic.png", "text/html", 200},
	} {
		status = test.status
		original := bytes.Repeat([]byte("a"), 512)
		f := &store.Flow{Method: test.method, Path: test.path, Status: &status, ReqRaw: original,
			ReqBody: original, RespHeaders: []store.Header{{N: "Content-Type", V: test.contentType}}}
		if !s.prepareCapture(f) || len(f.ReqRaw) != 128 || f.ReqSize != 512 || len(original) != 512 || len(f.ReqBody) != 0 {
			t.Fatalf("security traffic lost or original request changed: %+v", test)
		}
	}
}
