package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/chinaran404/replayd/internal/cert"
	"github.com/chinaran404/replayd/internal/store"
)

func proxyPost(t *testing.T, ts *httptest.Server, token, path, body string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	data, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return resp, data
}

func TestProxyLifecycleAPI(t *testing.T) {
	_, ts, token := newTestServer(t)

	// 启动
	resp, data := proxyPost(t, ts, token, "/api/proxy/start", `{"listen":"127.0.0.1:0"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("start status = %d (%s)", resp.StatusCode, data)
	}
	var st struct {
		Running bool   `json:"running"`
		Listen  string `json:"listen"`
	}
	_ = json.Unmarshal(data, &st)
	if !st.Running || st.Listen == "" {
		t.Fatalf("start 后状态: %s", data)
	}

	// 状态查询
	data2, _ := proxyGet(t, ts, token, "/api/proxy")
	var st2 proxyStatusResponse
	_ = json.Unmarshal(data2, &st2)
	if !st2.Running || !st2.CAReady {
		t.Errorf("status = %+v", st2)
	}

	// 停止
	_, data3 := proxyPost(t, ts, token, "/api/proxy/stop", "")
	var st3 proxyStatusResponse
	_ = json.Unmarshal(data3, &st3)
	if st3.Running {
		t.Error("stop 后应停止")
	}
}

func proxyGet(t *testing.T, ts *httptest.Server, token, path string) ([]byte, *http.Response) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	data, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return data, resp
}

func TestProxyCACerts(t *testing.T) {
	_, ts, token := newTestServer(t)

	pemData, resp := proxyGet(t, ts, token, "/api/proxy/ca.pem")
	if resp.StatusCode != 200 {
		t.Fatalf("ca.pem status = %d", resp.StatusCode)
	}
	block, rest := pem.Decode(pemData)
	if block == nil || block.Type != "CERTIFICATE" || len(rest) != 0 {
		t.Fatal("ca.pem 应为单证书 PEM")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		t.Fatalf("解析证书: %v", err)
	}

	derData, _ := proxyGet(t, ts, token, "/api/proxy/ca.crt")
	if !bytes.Equal(derData, block.Bytes) {
		t.Error("ca.crt 应为同一证书的 DER")
	}

	mc, _ := proxyGet(t, ts, token, "/api/proxy/ca.mobileconfig")
	if !bytes.Contains(mc, []byte("PayloadContent")) || !bytes.Contains(mc, []byte("replayd")) {
		t.Error("mobileconfig 应为描述文件 plist")
	}
}

func TestProxyDiagnose(t *testing.T) {
	_, ts, token := newTestServer(t)
	data, resp := proxyGet(t, ts, token, "/api/proxy/diagnose")
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var d struct {
		Trusted      bool     `json:"trusted"`
		Probe        string   `json:"probe"`
		Fingerprint  string   `json:"fingerprint"`
		Instructions []string `json:"instructions"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if d.Fingerprint == "" || len(d.Instructions) < 4 {
		t.Errorf("diagnose = %s", data)
	}
	// CI/测试机一般未安装 CA，trusted 应为 false；不强制断言，只要求字段存在
	if d.Probe == "" {
		t.Error("probe 说明不应为空")
	}
}

func TestProxyEndToEndViaAPI(t *testing.T) {
	srv, ts, token := newTestServer(t)

	// 启动代理 + 忽略上游校验（httptest 自签）
	proxyPost(t, ts, token, "/api/proxy/start", `{"listen":"127.0.0.1:0"}`)
	proxyPost(t, ts, token, "/api/proxy/insecure", `{"on":true}`)

	st := srv.proxy.Status()
	if !st.Running {
		t.Fatal("代理未运行")
	}

	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "via-proxy-e2e")
	}))
	defer up.Close()

	ca, err := cert.Load(srv.cfg.DataDir + "/ca")
	if err != nil {
		t.Fatalf("加载测试 CA: %v", err)
	}
	client := &http.Client{Transport: &http.Transport{
		Proxy:           func(*http.Request) (*url.URL, error) { return url.Parse("http://" + st.Listen) },
		TLSClientConfig: &tls.Config{RootCAs: ca.Pool()},
	}}
	resp, err := client.Get(up.URL + "/e2e")
	if err != nil {
		t.Fatalf("经代理请求失败: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if !bytes.Contains(body, []byte("via-proxy-e2e")) {
		t.Fatalf("body = %q", body)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		count, err := srv.store.CountFlows(t.Context(), store.Filter{Source: "proxy"})
		if err != nil {
			t.Fatal(err)
		}
		if count == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	flows, _, err := srv.store.ListFlows(context.Background(), store.Filter{Source: "proxy"})
	if err != nil {
		t.Fatalf("ListFlows: %v", err)
	}
	if len(flows) != 1 {
		t.Fatalf("应捕获 1 条 flow, got %d", len(flows))
	}
	f, err := srv.store.GetFlow(context.Background(), flows[0].ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if f.Method != "GET" || f.Path != "/e2e" || f.Status == nil || *f.Status != 200 {
		t.Errorf("flow: method=%s path=%s status=%v", f.Method, f.Path, f.Status)
	}
	if !bytes.Contains(f.RespRaw, []byte("via-proxy-e2e")) {
		t.Error("RespRaw 应含明文响应")
	}
}
