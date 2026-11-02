package httpreplay

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// ReadChunked 从 br 解析 chunked body（导出给 MITM 捕获客户端请求使用）。
// 到达 EOF 视为截断而不视为致命错误。
func ReadChunked(br *bufio.Reader, limit int64) (body []byte, truncated bool) {
	b, t, _, _ := readChunkedBody(br, limit, false)
	return b, t
}

// ParseResponseRaw 解析一段完整的原始响应字节（MITM 捕获后用于生成视图）。
// 与网络读取不同：这里 body 就是"剩余全部字节"，不再按 framing 拆分——
// 调用方传入的 raw 应当只包含一次响应（含其 body）。
func ParseResponseRaw(raw []byte) (*Response, error) {
	if len(raw) == 0 {
		return nil, errors.New("空响应")
	}
	br := bufio.NewReaderSize(bytes.NewReader(raw), 64<<10)

	line, err := readLineCapped(br, maxHeaderLine)
	if err != nil && line == "" {
		return nil, fmt.Errorf("无法读取状态行: %w", err)
	}
	proto, status, reason, ok := parseStatusParts(line)
	if !ok {
		return nil, fmt.Errorf("响应不是合法 HTTP: %q", truncate(strings.TrimSpace(line), 60))
	}

	headers, herr := readHeaderSection(br)
	if herr != nil {
		return nil, fmt.Errorf("解析响应头失败: %v", herr)
	}

	resp := &Response{
		Proto:   proto,
		Status:  status,
		Reason:  reason,
		Headers: headers,
		Raw:     raw,
	}

	// body = 缓冲区剩余部分
	body, rerr := io.ReadAll(io.LimitReader(br, 1<<30))
	resp.Body = body
	if rerr == nil && int64(len(body)) >= 1<<30 {
		resp.Truncated = true
	}
	return resp, nil
}

// StatusFromRaw 快速提取状态码（只要状态行；失败返回 0）。
func StatusFromRaw(raw []byte) int {
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\n' {
			_, status, _, ok := parseStatusParts(string(raw[:i]))
			if ok {
				return status
			}
			return 0
		}
	}
	_, status, _, ok := parseStatusParts(string(raw))
	if ok {
		return status
	}
	return 0
}

// Header 在头切片中查找（大小写不敏感）。
func HeaderIn(headers []Header, name string) (string, bool) {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value, true
		}
	}
	return "", false
}

// ContentLengthOf 返回 CL 头数值；缺失/非法返回 -1。
func ContentLengthOf(headers []Header) int {
	if v, ok := HeaderIn(headers, "Content-Length"); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return -1
}
