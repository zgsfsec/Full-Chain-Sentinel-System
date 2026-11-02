package config

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"REPLAYD_LISTEN", "REPLAYD_PROXY_LISTEN", "REPLAYD_DATA_DIR", "REPLAYD_TOKEN",
		"REPLAYD_LOG_LEVEL", "REPLAYD_OPEN_BROWSER", "REPLAYD_QUIET",
		"REPLAYD_RETENTION_DAYS", "REPLAYD_RETENTION_COUNT",
	} {
		t.Setenv(k, "")
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()

	cfg, err := Load([]string{"-data-dir", dir})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// 未显式指定端口 → 每次启动在 7000-8000 里随机分配
	assertRandomListen(t, cfg.Listen)
	assertRandomListen(t, cfg.ProxyListen)
	if cfg.Listen == cfg.ProxyListen {
		t.Errorf("控制台与代理端口不应相同: %q", cfg.Listen)
	}
	if !cfg.ListenRandom || !cfg.ProxyListenRandom {
		t.Errorf("应标记为随机分配: %v %v", cfg.ListenRandom, cfg.ProxyListenRandom)
	}
	if len(cfg.Token) != 64 {
		t.Errorf("Token 长度 = %d, want 64", len(cfg.Token))
	}
	if !cfg.TokenGenerated {
		t.Error("首次启动应标记 TokenGenerated")
	}

	// token 文件必须存在且权限为 0600。
	info, err := os.Stat(filepath.Join(dir, tokenFileName))
	if err != nil {
		t.Fatalf("token 文件: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("token 权限 = %o, want 600", perm)
	}
}

func TestTokenIsReused(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()

	first, err := Load([]string{"-data-dir", dir})
	if err != nil {
		t.Fatalf("第一次 Load: %v", err)
	}
	second, err := Load([]string{"-data-dir", dir})
	if err != nil {
		t.Fatalf("第二次 Load: %v", err)
	}
	if first.Token != second.Token {
		t.Error("复用同一数据目录时 token 应保持不变")
	}
	if second.TokenGenerated {
		t.Error("第二次不应标记 TokenGenerated")
	}
}

func TestPrecedenceFlagOverEnv(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	t.Setenv("REPLAYD_LISTEN", "127.0.0.1:9999")
	t.Setenv("REPLAYD_LOG_LEVEL", "debug")

	cfg, err := Load([]string{"-data-dir", dir, "-listen", "127.0.0.1:18899"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != "127.0.0.1:18899" {
		t.Errorf("flag 应覆盖 env，得到 %q", cfg.Listen)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("未显式传 flag 时应沿用 env，得到 %q", cfg.LogLevel)
	}
}

func TestEnvTokenWins(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	const tok = "0123456789abcdef0123456789abcdef"
	t.Setenv("REPLAYD_TOKEN", tok)

	cfg, err := Load([]string{"-data-dir", dir})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Token != tok {
		t.Errorf("Token = %q, want env 值", cfg.Token)
	}
	if _, err := os.Stat(filepath.Join(dir, tokenFileName)); !os.IsNotExist(err) {
		t.Error("使用 env token 时不应写 token 文件")
	}
}

func TestValidation(t *testing.T) {
	clearEnv(t)
	cases := []struct {
		name string
		args []string
	}{
		{"非法 listen", []string{"-listen", "nope"}},
		{"非法日志级别", []string{"-log-level", "verbose"}},
		{"保留天数过小", []string{"-retention-days", "0"}},
		{"显式 token 过短", []string{"-token", "short"}},
		{"负数报文上限", []string{"-proxy-max-capture-bytes", "-1"}},
		{"过大报文上限", []string{"-proxy-max-capture-bytes", "33554433"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			args := append([]string{"-data-dir", t.TempDir()}, tc.args...)
			if _, err := Load(args); err == nil {
				t.Fatal("期望返回错误，实际为 nil")
			}
		})
	}
}

func TestCapturePolicyFlags(t *testing.T) {
	clearEnv(t)
	cfg, err := Load([]string{"-data-dir", t.TempDir(), "-proxy-skip-static", "-proxy-max-capture-bytes", "2097152"})
	if err != nil || !cfg.ProxySkipStatic || cfg.ProxyMaxCaptureBytes != 2097152 {
		t.Fatalf("capture policy flags: cfg=%+v err=%v", cfg, err)
	}
}

func TestVersionRequested(t *testing.T) {
	clearEnv(t)
	cfg, err := Load([]string{"-version"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.VersionRequested {
		t.Error("VersionRequested 应为 true")
	}
}

func assertRandomListen(t *testing.T, addr string) {
	t.Helper()
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("地址不合法 %q: %v", addr, err)
	}
	if host != DefaultListenHost {
		t.Errorf("host = %q, want %q", host, DefaultListenHost)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < RandomPortMin || port > RandomPortMax {
		t.Errorf("port = %d, 应在 [%d,%d] 内", port, RandomPortMin, RandomPortMax)
	}
}

func TestLoadRandomPortsDifferPerRun(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	seen := map[string]bool{}
	dup := true
	for i := 0; i < 6; i++ {
		cfg, err := Load([]string{"-data-dir", dir})
		if err != nil {
			t.Fatalf("Load #%d: %v", i, err)
		}
		seen[cfg.Listen] = true
		if cfg.Listen != cfg.ProxyListen && cfg.ListenRandom {
			dup = dup && false
		}
	}
	if len(seen) < 2 {
		t.Errorf("多次启动应出现不同端口（概率性，6 次全同概率约 0.006%%），实际 %v", seen)
	}
}

func TestLoadExplicitListenBeatsRandom(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	cfg, err := Load([]string{"-data-dir", dir, "-listen", "127.0.0.1:18899"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != "127.0.0.1:18899" {
		t.Errorf("显式 -listen 应生效, got %q", cfg.Listen)
	}
	if cfg.ListenRandom {
		t.Error("显式指定时不应标记为随机")
	}
	// 代理未指定 → 仍是随机的
	assertRandomListen(t, cfg.ProxyListen)
	if !cfg.ProxyListenRandom {
		t.Error("代理未指定时应标记为随机")
	}
}

func TestLoadEnvListenBeatsRandom(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	t.Setenv("REPLAYD_LISTEN", "127.0.0.1:18777")
	cfg, err := Load([]string{"-data-dir", dir})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != "127.0.0.1:18777" {
		t.Errorf("env 应生效, got %q", cfg.Listen)
	}
	if cfg.ListenRandom {
		t.Error("env 指定时不应标记为随机")
	}
}
