package proxy

import (
	"bufio"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/chinaran404/replayd/internal/store"
)

func authenticatedProxy(t *testing.T, username, password string) *proxyEnv {
	t.Helper()
	e := newProxyEnv(t)
	if err := e.srv.Stop(); err != nil {
		t.Fatal(err)
	}
	salt := []byte("0123456789abcdef")
	hash, err := pbkdf2.Key(sha256.New, password, salt, 100000, 32)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(struct {
		Enabled  bool   `json:"authEnabled"`
		Username string `json:"authUsername"`
		Salt     string `json:"authSalt"`
		Hash     string `json:"authPasswordHash"`
	}{true, username, hex.EncodeToString(salt), hex.EncodeToString(hash)})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.srv.LoadAuthentication(path); err != nil {
		t.Fatal(err)
	}
	if err := e.srv.Start("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	e.addr = e.srv.Status().Listen
	return e
}

func TestProxyAuthenticationRejectsBeforeForwardingOrReadingBody(t *testing.T) {
	e := authenticatedProxy(t, "operator", "p@ss:word123")
	e.srv.SetBypass("127.0.0.1", true)
	var upstreamCalls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		fmt.Fprint(w, "should not be reached")
	}))
	defer up.Close()
	valid := "Basic " + base64.StdEncoding.EncodeToString([]byte("operator:p@ss:word123"))
	for _, headers := range []string{
		"", "Proxy-Authorization: Bearer invalid\r\n", "Proxy-Authorization: Basic !!!\r\n",
		"Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("operator:wrong")) + "\r\n",
		"Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("another:p@ss:word123")) + "\r\n",
		"Proxy-Authorization: " + valid + "\r\nproxy-authorization: " + valid + "\r\n",
	} {
		for _, first := range []string{
			"GET " + up.URL + "/ HTTP/1.1",
			"POST " + up.URL + "/ HTTP/1.1",
			"CONNECT " + strings.TrimPrefix(up.URL, "http://") + " HTTP/1.1",
			"GET " + up.URL + "/ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade",
		} {
			conn, err := net.DialTimeout("tcp", e.addr, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
			// No body follows: a 407 must arrive without waiting for the advertised bytes.
			fmt.Fprintf(conn, "%s\r\nHost: 127.0.0.1\r\n%sContent-Length: 1000000\r\n\r\n", first, headers)
			resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal(err)
			}
			if resp.StatusCode != 407 || !strings.Contains(resp.Header.Get("Proxy-Authenticate"), "Basic") {
				t.Fatalf("expected proxy challenge, got %d", resp.StatusCode)
			}
			_ = resp.Body.Close()
			_ = conn.Close()
		}
	}
	count, err := e.st.CountFlows(t.Context(), store.Filter{Source: "proxy"})
	if err != nil || count != 0 || upstreamCalls.Load() != 0 {
		t.Fatalf("rejected request was forwarded or captured: flows=%d calls=%d err=%v", count, upstreamCalls.Load(), err)
	}
}

func TestProxyAuthenticationHTTPAndHTTPSRedactCredentials(t *testing.T) {
	e := authenticatedProxy(t, "operator", "p@ss:word123")
	e.srv.SetInsecureUpstream(true)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credentials reached target")
		}
		fmt.Fprint(w, "authorized")
	})
	plain := httptest.NewServer(handler)
	defer plain.Close()
	secure := httptest.NewTLSServer(handler)
	defer secure.Close()
	proxyURL, err := url.Parse("http://" + e.addr)
	if err != nil {
		t.Fatal(err)
	}
	proxyURL.User = url.UserPassword("operator", "p@ss:word123")
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), TLSClientConfig: &tls.Config{RootCAs: e.ca.Pool()}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	for _, origin := range []string{plain.URL, secure.URL} {
		for range 2 {
			resp, err := client.Get(origin + "/authenticated")
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if err != nil || resp.StatusCode != 200 || string(body) != "authorized" {
				t.Fatalf("authorized request failed: %s %v", body, err)
			}
		}
	}
	flows, _, err := e.st.ListFlows(t.Context(), store.Filter{Source: "proxy"})
	if err != nil || len(flows) != 4 {
		t.Fatalf("capture count=%d err=%v", len(flows), err)
	}
	for _, row := range flows {
		flow, err := e.st.GetFlow(t.Context(), row.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.ToLower(string(flow.ReqRaw)), "proxy-authorization") {
			t.Fatal("credential in captured bytes")
		}
		for _, header := range flow.ReqHeaders {
			if strings.EqualFold(header.N, "Proxy-Authorization") {
				t.Fatal("credential in stored headers")
			}
		}
	}
}

func TestProxyAuthenticationRequiredOnEachPlainRequest(t *testing.T) {
	e := authenticatedProxy(t, "operator", "long-password")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") }))
	defer up.Close()
	conn, err := net.DialTimeout("tcp", e.addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(conn)
	credential := base64.StdEncoding.EncodeToString([]byte("operator:long-password"))
	fmt.Fprintf(conn, "GET %s/ HTTP/1.1\r\nHost: ignored\r\nProxy-Authorization: Basic %s\r\n\r\n", up.URL, credential)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	fmt.Fprintf(conn, "GET %s/ HTTP/1.1\r\nHost: ignored\r\n\r\n", up.URL)
	resp, err = http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 407 {
		t.Fatal("keep-alive bypassed authentication")
	}
}

func TestProxyAuthenticationInvalidFilesFailClosed(t *testing.T) {
	s := &Server{}
	path := filepath.Join(t.TempDir(), "auth.json")
	if s.LoadAuthentication(path) == nil {
		t.Fatal("missing auth file accepted")
	}
	for _, data := range []string{"bad JSON", "{}", `{"authEnabled":true}`, `{"authEnabled":true,"authUsername":"admin","authSalt":"00","authPasswordHash":"00"}`} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if s.LoadAuthentication(path) == nil {
			t.Fatal("invalid auth file accepted")
		}
	}
	if err := os.WriteFile(path, []byte(`{"authEnabled":false}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.LoadAuthentication(path); err != nil {
		t.Fatal(err)
	}
	if !s.authorized("") {
		t.Fatal("explicitly disabled auth rejected")
	}
}
