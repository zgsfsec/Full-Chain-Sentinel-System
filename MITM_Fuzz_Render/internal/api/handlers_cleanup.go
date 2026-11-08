package api

import (
	"net/http"
	"regexp"
)

var captureID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

func (s *Server) handleProxyDeleteFlows(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs     []string `json:"ids"`
		Confirm bool     `json:"confirm"`
	}
	if decodeJSONBody(r, &input) != nil || !input.Confirm || (input.IDs != nil && (len(input.IDs) < 1 || len(input.IDs) > 100)) {
		s.writeError(w, 400, "bad_request", "请确认清空或选择 1–100 条流量", nil)
		return
	}
	for _, id := range input.IDs {
		if !captureID.MatchString(id) {
			s.writeError(w, 400, "bad_request", "流量 ID 无效", nil)
			return
		}
	}
	deleted, err := s.store.DeleteProxyFlows(r.Context(), input.IDs)
	if err != nil {
		s.writeError(w, 500, "internal", "流量清理未完成，部分批次可能已删除，请刷新后重试", map[string]int64{"deleted": deleted})
		return
	}
	s.writeJSON(w, 200, map[string]int64{"deleted": deleted})
}
