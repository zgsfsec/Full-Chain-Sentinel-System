package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chinaran404/replayd/internal/store"
)

func TestCaptureCleanupAPIRequiresConfirmationAndPreservesReplay(t *testing.T) {
	srv, ts, token := newTestServer(t)
	for _, flow := range []*store.Flow{
		{ID: "capture", Source: "proxy", Method: "GET", Host: "test", Path: "/"},
		{ID: "replayed", Source: "replay", Method: "GET", Host: "test", Path: "/"},
	} {
		if err := srv.store.InsertFlow(t.Context(), flow); err != nil {
			t.Fatal(err)
		}
	}
	for _, body := range []string{`{}`, `{"confirm":false}`, `{"confirm":true,"ids":[]}`, `{"confirm":true,"ids":["../x"]}`} {
		resp, _ := proxyPost(t, ts, token, "/api/proxy/flows/delete", body)
		if resp.StatusCode != 400 {
			t.Fatalf("invalid cleanup accepted: %s", body)
		}
	}
	resp, _ := proxyPost(t, ts, "wrong", "/api/proxy/flows/delete", `{"confirm":true}`)
	if resp.StatusCode != 401 {
		t.Fatal("unauthenticated cleanup accepted")
	}
	resp, data := proxyPost(t, ts, token, "/api/proxy/flows/delete", `{"confirm":true,"ids":["capture","replayed"]}`)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"deleted":1`) {
		t.Fatalf("cleanup failed: %s", data)
	}
	if _, err := srv.store.GetFlow(t.Context(), "replayed", false); err != nil {
		t.Fatal("replay deleted")
	}
}

func TestReplayReturnsActualChunkedWireBytesOnRequest(t *testing.T) {
	srv, _, _ := newTestServer(t)
	wire := "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nx-A: 1\r\nx-A: 2\r\n\r\n2\r\nok\r\n0\r\nX-End: yes\r\n\r\n"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		fmt.Fprint(conn, wire)
	}))
	defer up.Close()
	save := false
	for _, include := range []bool{false, true} {
		result := srv.doReplay(t.Context(), replayRequest{Raw: "GET " + up.URL + "/ HTTP/1.1\r\n\r\n", Save: &save, Opts: replayOptions{IncludeRaw: include}}, nil)
		if result.Error != nil || result.Response == nil || result.Response.BodyText != "ok" {
			t.Fatalf("replay failed: %+v", result)
		}
		if include {
			raw, err := base64.StdEncoding.DecodeString(result.Response.RawBase64)
			if err != nil || string(raw) != wire || result.Response.RawTruncated {
				t.Fatalf("wire response changed: %q err=%v", raw, err)
			}
		} else if result.Response.RawBase64 != "" {
			t.Fatal("raw should be opt-in")
		}
		if _, err := json.Marshal(result); err != nil {
			t.Fatal(err)
		}
	}
}
