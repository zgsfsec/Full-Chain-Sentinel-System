package proxy

import (
	"bufio"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
)

var errProxyAuth = errors.New("proxy authentication required")

type proxyCredentials struct {
	username string
	salt     []byte
	hash     []byte
}

// LoadAuthentication must run before Start. A missing or invalid file fails closed.
func (s *Server) LoadAuthentication(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return errors.New("stop the proxy before changing authentication")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return errors.New("cannot read proxy authentication file")
	}
	var cfg struct {
		Enabled      *bool  `json:"authEnabled"`
		Username     string `json:"authUsername"`
		Salt         string `json:"authSalt"`
		PasswordHash string `json:"authPasswordHash"`
	}
	if json.Unmarshal(data, &cfg) != nil || cfg.Enabled == nil {
		return errors.New("invalid proxy authentication file")
	}
	if !*cfg.Enabled {
		s.auth = nil
		return nil
	}
	salt, saltErr := hex.DecodeString(cfg.Salt)
	hash, hashErr := hex.DecodeString(cfg.PasswordHash)
	validUsername := len(cfg.Username) > 0 && len(cfg.Username) <= 64
	for _, ch := range cfg.Username {
		if ch < 0x21 || ch > 0x7e || ch == ':' {
			validUsername = false
		}
	}
	if !validUsername || saltErr != nil || hashErr != nil || len(salt) != 16 || len(hash) != 32 {
		return errors.New("invalid proxy authentication credentials")
	}
	s.auth = &proxyCredentials{username: cfg.Username, salt: salt, hash: hash}
	return nil
}

func (s *Server) authorized(value string) bool {
	if s.auth == nil {
		return true
	}
	scheme, encoded, ok := strings.Cut(value, " ")
	if !ok || !strings.EqualFold(scheme, "Basic") || len(encoded) > 512 {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return false
	}
	username, password, ok := strings.Cut(string(decoded), ":")
	if !ok || len(password) > 128 {
		return false
	}
	hash, err := pbkdf2.Key(sha256.New, password, s.auth.salt, 100000, 32)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(username), []byte(s.auth.username))&subtle.ConstantTimeCompare(hash, s.auth.hash) == 1
}

func writeProxyAuthRequired(conn net.Conn) {
	_, _ = conn.Write([]byte("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"MITM Center\", charset=\"UTF-8\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
}

// Read headers before the body so unauthorized uploads are rejected immediately.
// Proxy credentials, including folded continuation lines, never reach upstream or storage.
func readProxyHead(br *bufio.Reader, firstLine string) ([]byte, string, error) {
	var head strings.Builder
	head.WriteString(firstLine)
	if !strings.HasSuffix(firstLine, "\n") {
		head.WriteString("\n")
	}
	credential := ""
	credentialCount := 0
	skipContinuation := false
	total := len(firstLine)
	for i := 0; i < maxHeadLines; i++ {
		line, err := readLineCapped(br, maxHeadLineBytes)
		total += len(line)
		if err != nil {
			return nil, "", err
		}
		if total > maxHeadLineBytes {
			return nil, "", errors.New("proxy headers too large")
		}
		if strings.TrimRight(line, "\r\n") == "" {
			head.WriteString(line)
			if credentialCount > 1 {
				credential = "" // Duplicate credentials are ambiguous; do not authenticate.
			}
			return []byte(head.String()), credential, nil
		}
		if line[0] == ' ' || line[0] == '\t' {
			if skipContinuation {
				credential = ""
				continue
			}
		} else {
			name, value, _ := strings.Cut(line, ":")
			skipContinuation = strings.EqualFold(strings.TrimSpace(name), "Proxy-Authorization")
			if skipContinuation {
				credentialCount++
				credential = strings.TrimSpace(value)
				continue
			}
		}
		head.WriteString(line)
	}
	return nil, "", errors.New("too many proxy headers")
}
