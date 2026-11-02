package proxy

import (
	"fmt"
	"mime"
	"net/url"
	"path"
	"strings"

	"github.com/chinaran404/replayd/internal/store"
)

// SetCapturePolicy controls persistence only; forwarding uses the original bytes.
func (s *Server) SetCapturePolicy(skipStatic bool, maxBytes int64) {
	s.skipStatic.Store(skipStatic)
	s.maxCaptureBytes.Store(maxBytes)
}

// prepareCapture filters before any blob is written and caps both raw messages.
func (s *Server) prepareCapture(f *store.Flow) bool {
	if s.skipStatic.Load() && staticFlow(f) {
		return false
	}
	limit := s.maxCaptureBytes.Load()
	if limit <= 0 {
		return true
	}
	f.ReqSize = int64(len(f.ReqRaw))
	f.RespSize = int64(len(f.RespRaw))
	var truncated []string
	if int64(len(f.ReqRaw)) > limit {
		f.ReqRaw = f.ReqRaw[:limit]
		truncated = append(truncated, "request")
	}
	if int64(len(f.RespRaw)) > limit {
		f.RespRaw = f.RespRaw[:limit]
		truncated = append(truncated, "response")
	}
	// The centre reads raw messages only; do not duplicate the same body in blobs.
	f.ReqBody, f.RespBody = nil, nil
	if len(truncated) > 0 {
		f.Note = strings.TrimSpace(f.Note + fmt.Sprintf(" capture-truncated(%s, limit=%d bytes)", strings.Join(truncated, ","), limit))
	}
	return true
}

func staticFlow(f *store.Flow) bool {
	// Keep submissions and failed responses even when their URL resembles an image.
	if (f.Method != "GET" && f.Method != "HEAD") || len(f.Error) > 0 || f.Status == nil || (*f.Status >= 400) {
		return false
	}
	for _, header := range f.RespHeaders {
		if !strings.EqualFold(header.N, "Content-Type") {
			continue
		}
		media, _, _ := mime.ParseMediaType(header.V)
		media = strings.ToLower(media)
		// A dynamic endpoint can use a static-looking URL; keep its actionable content.
		if media == "text/html" || media == "application/json" || strings.HasSuffix(media, "+json") ||
			media == "application/xml" || media == "text/xml" || strings.HasSuffix(media, "+xml") ||
			media == "application/javascript" || media == "text/javascript" {
			return false
		}
		if strings.HasPrefix(media, "image/") || strings.HasPrefix(media, "video/") ||
			strings.HasPrefix(media, "audio/") || strings.HasPrefix(media, "font/") ||
			media == "text/css" || media == "application/font-woff" || media == "application/vnd.ms-fontobject" {
			return true
		}
	}
	p := f.Path
	if decoded, err := url.PathUnescape(p); err == nil {
		p = decoded
	}
	switch strings.ToLower(path.Ext(p)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".ico", ".tif", ".tiff",
		".mp4", ".m4v", ".mov", ".avi", ".wmv", ".webm", ".flv", ".mpeg", ".mpg",
		".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".css":
		return true
	}
	return false
}
