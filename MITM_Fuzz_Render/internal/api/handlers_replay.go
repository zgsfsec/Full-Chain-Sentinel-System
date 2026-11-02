package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/chinaran404/replayd/internal/httpreplay"
	"github.com/chinaran404/replayd/internal/script"
	"github.com/chinaran404/replayd/internal/store"
)

// ---------------------------------------------------------------- POST /api/replay

type replayTarget struct {
	Scheme string `json:"scheme"`
	Host   string `json:"host"`
	Port   int    `json:"port"`
}

type replayOptions struct {
	InsecureTLS      bool   `json:"insecureTLS"`
	SNI              string `json:"sni"`
	TLSMinVersion    string `json:"tlsMin"`
	UpstreamProxy    string `json:"upstreamProxy"`
	ConnectTimeoutMS int64  `json:"connectTimeoutMs"`
	HeaderTimeoutMS  int64  `json:"headerTimeoutMs"`
	TotalTimeoutMS   int64  `json:"totalTimeoutMs"`
	DisableAutoHost  bool   `json:"disableAutoHost"`
	DisableAutoClose bool   `json:"disableAutoClose"`
	IncludeRaw       bool   `json:"includeRaw"`
}

type replayRequest struct {
	Raw      string        `json:"raw"`
	Target   replayTarget  `json:"target"`
	Opts     replayOptions `json:"options"`
	Save     *bool         `json:"save"`
	ScriptID string        `json:"scriptId"`
}

type replayResponse struct {
	FlowID     string             `json:"flowId,omitempty"`
	Request    replayReqView      `json:"request"`
	Response   *replayRespView    `json:"response,omitempty"`
	Timings    httpreplay.Timings `json:"timings"`
	Error      *httpreplay.Error  `json:"error,omitempty"`
	DurationMS int64              `json:"durationMs"`
	Script     *script.Output     `json:"script,omitempty"`
}

type replayReqView struct {
	Raw      string               `json:"raw"`
	Sent     string               `json:"sent,omitempty"`
	URL      httpreplay.Target    `json:"url"`
	Warnings []httpreplay.Warning `json:"warnings,omitempty"`
}

type replayRespView struct {
	Proto        string              `json:"proto"`
	Status       int                 `json:"status"`
	Reason       string              `json:"reason"`
	Headers      []httpreplay.Header `json:"headers,omitempty"`
	BodyText     string              `json:"bodyText,omitempty"`
	BodyBase64   string              `json:"bodyBase64,omitempty"`
	Truncated    bool                `json:"truncated"`
	Size         int                 `json:"size"`
	RawBase64    string              `json:"rawBase64,omitempty"`
	RawTruncated bool                `json:"rawTruncated,omitempty"`
}

func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	var in replayRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法: "+err.Error(), nil)
		return
	}
	if strings.TrimSpace(in.Raw) == "" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "raw 不能为空", nil)
		return
	}

	var sc *store.Script
	if in.ScriptID != "" {
		loaded, err := s.store.GetScript(r.Context(), in.ScriptID)
		if errors.Is(err, store.ErrNotFound) {
			s.writeError(w, http.StatusNotFound, "not_found", "脚本不存在", in.ScriptID)
			return
		}
		if err != nil {
			s.writeError(w, http.StatusInternalServerError, "internal", "读取脚本失败", nil)
			return
		}
		sc = loaded
	}

	s.writeJSON(w, http.StatusOK, s.doReplay(r.Context(), in, sc))
}

// doReplay 是重放的核心：解析目标 → （可选）脚本 onRequest → 发送 → 脚本 onResponse/onAssert → 落库。
// 引擎与脚本错误都以 200 + error 字段表达，而不是 HTTP 4xx/5xx。
func (s *Server) doReplay(ctx context.Context, in replayRequest, sc *store.Script) replayResponse {
	out := replayResponse{}

	opts := httpreplay.Options{
		InsecureTLS:      in.Opts.InsecureTLS,
		SNI:              in.Opts.SNI,
		TLSMinVersion:    in.Opts.TLSMinVersion,
		UpstreamProxy:    in.Opts.UpstreamProxy,
		DisableAutoHost:  in.Opts.DisableAutoHost,
		DisableAutoClose: in.Opts.DisableAutoClose,
	}
	fallback := targetFromReplay(&in.Target)
	if fallback.Host == "" {
		// 调用方只给了数据包：目标就在报文里（absolute-form 请求行或 Host 头）。
		if derived, ok := httpreplay.TargetFromRaw([]byte(in.Raw)); ok {
			fallback = derived
		}
	}
	if fallback.Host != "" {
		opts.FallbackURL = absURL(fallback)
	}
	if in.Opts.ConnectTimeoutMS > 0 {
		opts.ConnectTimeout = time.Duration(in.Opts.ConnectTimeoutMS) * time.Millisecond
	}
	if in.Opts.HeaderTimeoutMS > 0 {
		opts.HeaderTimeout = time.Duration(in.Opts.HeaderTimeoutMS) * time.Millisecond
	}
	if in.Opts.TotalTimeoutMS > 0 {
		opts.TotalTimeout = time.Duration(in.Opts.TotalTimeoutMS) * time.Millisecond
	}

	sendRaw := []byte(in.Raw)
	var sess *script.Session

	if sc != nil {
		if !sc.Enabled {
			out.Error = &httpreplay.Error{Code: "script_disabled", Message: "脚本已停用，未发送请求"}
			out.Request = replayReqView{Raw: in.Raw}
			return out
		}
		parsed, perr := httpreplay.ParseRequest(sendRaw, fallback)
		if perr != nil {
			out.Error = &httpreplay.Error{Code: "bad_request", Message: "无法解析请求: " + perr.Error()}
			out.Request = replayReqView{Raw: in.Raw}
			return out
		}
		started, started2 := s.script.Start(ctx, script.Input{
			Source:  sc.Source,
			Hooks:   toScriptHooks(sc.Hooks),
			Request: scriptRequestFromEngine(parsed),
			Timeout: script.DefaultTimeout,
			Vars:    map[string]string{},
		})
		sess = started
		out.Script = &started2
		if started2.Error != "" {
			out.Error = &httpreplay.Error{Code: "script_error", Message: started2.Error}
			out.Request = replayReqView{Raw: in.Raw, URL: parsed.URL}
			return out
		}
		sendRaw = []byte(started2.Request.RawRequest(parsed.Target))
	}

	timeout := opts.TotalTimeout + 5*time.Second
	if timeout <= 0 {
		timeout = 125 * time.Second
	}
	sctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	res := s.replay.Send(sctx, sendRaw, opts)
	out.Timings = res.Timings
	out.DurationMS = res.Timings.TotalMS
	if res.Request != nil {
		out.Request = replayReqView{
			Raw:      string(sendRaw),
			URL:      res.Request.URL,
			Warnings: res.Request.Warnings,
		}
	}
	if res.Response != nil {
		out.Response = newRespView(res.Response)
		if in.Opts.IncludeRaw {
			raw := res.Response.Raw
			if len(raw) > 128*1024 {
				raw = raw[:128*1024]
			}
			out.Response.RawBase64 = base64.StdEncoding.EncodeToString(raw)
			out.Response.RawTruncated = int64(len(raw)) < res.Response.RawSize
		}
	}
	out.Error = res.Err

	// 响应阶段脚本
	if sess != nil {
		final := sess.Response(scriptResponseFromEngine(res.Response))
		out.Script = &final
		if final.Error != "" && out.Error == nil {
			out.Error = &httpreplay.Error{Code: "script_error", Message: final.Error}
		}
	}

	// 落库：无论引擎是否报错，只要请求已发出就值得记录
	save := in.Save == nil || *in.Save
	if save && res.Request != nil && res.Request.URL.Host != "" {
		flow := flowFromResult(res)
		if err := s.store.InsertFlow(ctx, flow); err == nil {
			out.FlowID = flow.ID
			s.bus.Publish("flow.new", map[string]any{
				"id": flow.ID, "source": "replay", "method": flow.Method,
				"scheme": flow.Scheme, "host": flow.Host, "port": flow.Port,
				"path": flow.Path, "status": flow.Status,
				"ts": flow.TS, "durationMs": flow.DurationMS,
			})
		}
	}

	if sc != nil && out.Script != nil {
		s.recordScriptRun(ctx, sc.ID, out.FlowID, *out.Script)
	}
	return out
}

func newRespView(resp *httpreplay.Response) *replayRespView {
	v := &replayRespView{
		Proto:     resp.Proto,
		Status:    resp.Status,
		Reason:    resp.Reason,
		Headers:   resp.Headers,
		Truncated: resp.Truncated,
		Size:      len(resp.Body),
	}
	if utf8.Valid(resp.Body) {
		v.BodyText = string(resp.Body)
	} else {
		v.BodyBase64 = base64.StdEncoding.EncodeToString(resp.Body)
	}
	return v
}

// flowFromResult 把引擎结果转换为可入库的 flow。
func flowFromResult(res httpreplay.Result) *store.Flow {
	req := res.Request
	f := &store.Flow{
		Source:      "replay",
		Method:      req.Method,
		Scheme:      req.URL.Scheme,
		Host:        req.URL.Host,
		Port:        req.URL.Port,
		Path:        req.URL.Path,
		HTTPVersion: req.Proto,
		ReqHeaders:  convHeaders(req.Headers),
		ReqRaw:      req.Raw,
		ReqBody:     req.Body,
	}
	if i := indexQuery(req.URL.Path); i >= 0 {
		f.Path, f.Query = req.URL.Path[:i], req.URL.Path[i+1:]
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
	return f
}

func indexQuery(p string) int {
	for i := 0; i < len(p); i++ {
		if p[i] == '?' {
			return i
		}
	}
	return -1
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

// ---------------------------------------------------------------- tabs CRUD

type tabListResponse struct {
	Items []*store.Tab `json:"items"`
}

func (s *Server) handleListTabs(w http.ResponseWriter, r *http.Request) {
	tabs, err := s.store.ListTabs(r.Context(), "")
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取标签页失败", nil)
		return
	}
	if tabs == nil {
		tabs = []*store.Tab{}
	}
	s.writeJSON(w, http.StatusOK, tabListResponse{Items: tabs})
}

type createTabRequest struct {
	Name       string `json:"name"`
	RawRequest string `json:"rawRequest"`
}

func (s *Server) handleCreateTab(w http.ResponseWriter, r *http.Request) {
	var in createTabRequest
	if err := decodeJSONBody(r, &in); err != nil && err.Error() != "EOF" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法", nil)
		return
	}
	tab := &store.Tab{Name: in.Name, RawRequest: in.RawRequest}
	if err := s.store.InsertTab(r.Context(), tab); err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "创建标签页失败", nil)
		return
	}
	s.writeJSON(w, http.StatusCreated, tab)
}

func (s *Server) handleGetTab(w http.ResponseWriter, r *http.Request) {
	tab, err := s.store.GetTab(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "标签页不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "读取标签页失败", nil)
		return
	}
	s.writeJSON(w, http.StatusOK, tab)
}

type patchTabRequest struct {
	Name       *string `json:"name"`
	RawRequest *string `json:"rawRequest"`
	ScriptID   *string `json:"scriptId"`
}

func (s *Server) handlePatchTab(w http.ResponseWriter, r *http.Request) {
	var in patchTabRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法", nil)
		return
	}
	tab, err := s.store.UpdateTab(r.Context(), chi.URLParam(r, "id"), store.TabPatch{
		Name:       in.Name,
		RawRequest: in.RawRequest,
		ScriptID:   in.ScriptID,
	})
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "标签页不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "更新标签页失败", nil)
		return
	}
	s.writeJSON(w, http.StatusOK, tab)
}

func (s *Server) handleDeleteTab(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteTab(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		s.writeError(w, http.StatusNotFound, "not_found", "标签页不存在", nil)
		return
	}
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "删除标签页失败", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// toScriptHooks 把存储层的钩子声明转换为运行时类型。
func toScriptHooks(h store.Hooks) script.Hooks {
	return script.Hooks{OnRequest: h.OnRequest, OnResponse: h.OnResponse, OnAssert: h.OnAssert}
}
