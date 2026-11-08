package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(context.Background(), dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestMigrate(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	var version int
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		t.Fatalf("读取迁移版本: %v", err)
	}
	if version != 4 {
		t.Errorf("迁移版本 = %d, want 4（含 proxy_paging）", version)
	}
	// 两张表都应可用
	for _, table := range []string{"flows", "artifacts"} {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM `+table).Scan(&n); err != nil {
			t.Errorf("表 %s 不可用: %v", table, err)
		}
	}

	pid, err := s.DefaultProjectID(ctx)
	if err != nil {
		t.Fatalf("DefaultProjectID: %v", err)
	}
	if pid == "" {
		t.Error("默认项目 ID 不应为空")
	}
}

func TestInsertAndGetFlow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	status := 201
	dur := int64(42)
	f := &Flow{
		Source:      "replay",
		Method:      "POST",
		Scheme:      "https",
		Host:        "example.com",
		Port:        443,
		Path:        "/api/login",
		Query:       "a=1",
		HTTPVersion: "HTTP/1.1",
		DurationMS:  &dur,
		Status:      &status,
		ReqHeaders:  []Header{{"Host", "example.com"}, {"X-Test", "1"}},
		RespHeaders: []Header{{"Content-Type", "application/json"}},
		ReqBody:     []byte(`{"user":"a"}`),
		RespBody:    []byte(`{"ok":true}`),
		ReqRaw:      []byte("POST /api/login HTTP/1.1\r\nHost: example.com\r\n\r\n{\"user\":\"a\"}"),
		RespRaw:     []byte("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}"),
		Tags:        []string{"auth"},
	}
	if err := s.InsertFlow(ctx, f); err != nil {
		t.Fatalf("InsertFlow: %v", err)
	}
	if f.ID == "" {
		t.Fatal("InsertFlow 应回填 ID")
	}

	got, err := s.GetFlow(ctx, f.ID, true)
	if err != nil {
		t.Fatalf("GetFlow: %v", err)
	}
	if got.Method != "POST" || got.Host != "example.com" || got.Port != 443 {
		t.Errorf("元数据不一致: %+v", got)
	}
	if got.Query != "a=1" {
		t.Errorf("Query = %q", got.Query)
	}
	if len(got.ReqHeaders) != 2 || got.ReqHeaders[1].N != "X-Test" {
		t.Errorf("请求头未保序: %+v", got.ReqHeaders)
	}
	if string(got.ReqBody) != `{"user":"a"}` {
		t.Errorf("ReqBody = %q", got.ReqBody)
	}
	if string(got.RespRaw) != string(f.RespRaw) {
		t.Error("RespRaw 不一致")
	}
	if got.ReqSize != int64(len(f.ReqRaw)) {
		t.Errorf("ReqSize = %d, want %d", got.ReqSize, len(f.ReqRaw))
	}
	if got.Status == nil || *got.Status != 201 {
		t.Errorf("Status = %v", got.Status)
	}
	if len(got.Tags) != 1 || got.Tags[0] != "auth" {
		t.Errorf("Tags = %v", got.Tags)
	}

	// 不取 body 时不应加载大字段。
	light, err := s.GetFlow(ctx, f.ID, false)
	if err != nil {
		t.Fatalf("GetFlow(light): %v", err)
	}
	if light.ReqBody != nil || light.RespBody != nil {
		t.Error("withBodies=false 时不应加载 body")
	}
}

func TestBlobDedup(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	body := []byte("same-body")

	for i := 0; i < 2; i++ {
		f := &Flow{Source: "proxy", Method: "GET", Scheme: "http", Host: "a.test", Port: 80,
			Path: "/", RespBody: body}
		if err := s.InsertFlow(ctx, f); err != nil {
			t.Fatalf("InsertFlow #%d: %v", i, err)
		}
	}

	var n, ref int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1), MAX(refcount) FROM blobs`).Scan(&n, &ref); err != nil {
		t.Fatalf("查询 blobs: %v", err)
	}
	if n != 1 {
		t.Errorf("相同 body 应只存一份 blob，实际 %d 份", n)
	}
	if ref != 2 {
		t.Errorf("引用计数 = %d, want 2", ref)
	}

	sha := sha256Hex(body)
	if _, err := os.Stat(filepath.Join(s.dataDir, "blobs", sha[0:2], sha[2:4], sha)); err != nil {
		t.Errorf("blob 文件应存在: %v", err)
	}
}

func TestListPagination(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	const total = 7
	for i := 0; i < total; i++ {
		f := &Flow{Source: "proxy", Method: "GET", Scheme: "https", Host: "h.test", Port: 443,
			Path: "/p", TS: int64(1000 + i)}
		if err := s.InsertFlow(ctx, f); err != nil {
			t.Fatalf("InsertFlow: %v", err)
		}
	}

	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		items, next, err := s.ListFlows(ctx, Filter{Limit: 3, Cursor: cursor})
		if err != nil {
			t.Fatalf("ListFlows: %v", err)
		}
		pages++
		for _, it := range items {
			if seen[it.ID] {
				t.Fatalf("分页出现重复项 %s", it.ID)
			}
			seen[it.ID] = true
		}
		if next == "" {
			break
		}
		cursor = next
		if pages > 10 {
			t.Fatal("分页未终止")
		}
	}
	if len(seen) != total {
		t.Errorf("遍历到 %d 条, want %d", len(seen), total)
	}
	if pages != 3 {
		t.Errorf("页数 = %d, want 3", pages)
	}
}

func TestListFilters(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	status200 := 200

	flows := []*Flow{
		{Source: "proxy", Method: "GET", Scheme: "https", Host: "a.test", Port: 443, Path: "/x", Status: &status200},
		{Source: "replay", Method: "POST", Scheme: "https", Host: "b.test", Port: 443, Path: "/login"},
		{Source: "proxy", Method: "GET", Scheme: "https", Host: "c.test", Port: 443, Path: "/y"},
	}
	for _, f := range flows {
		if err := s.InsertFlow(ctx, f); err != nil {
			t.Fatalf("InsertFlow: %v", err)
		}
	}

	cases := []struct {
		name string
		f    Filter
		want int
	}{
		{"按 host", Filter{Host: "a.test"}, 1},
		{"按方法", Filter{Method: "post"}, 1},
		{"按来源", Filter{Source: "proxy"}, 2},
		{"按状态", Filter{Status: &status200}, 1},
		{"按关键字", Filter{Search: "log"}, 1},
		{"无过滤", Filter{}, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			items, _, err := s.ListFlows(ctx, tc.f)
			if err != nil {
				t.Fatalf("ListFlows: %v", err)
			}
			if len(items) != tc.want {
				t.Errorf("命中 %d 条, want %d", len(items), tc.want)
			}
		})
	}
}

func TestDeleteFlow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	f := &Flow{Source: "replay", Method: "GET", Scheme: "http", Host: "d.test", Port: 80,
		Path: "/", RespBody: []byte("bye")}
	if err := s.InsertFlow(ctx, f); err != nil {
		t.Fatalf("InsertFlow: %v", err)
	}
	if err := s.DeleteFlow(ctx, f.ID); err != nil {
		t.Fatalf("DeleteFlow: %v", err)
	}
	if _, err := s.GetFlow(ctx, f.ID, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("删除后应返回 ErrNotFound, got %v", err)
	}
	var ref int
	if err := s.db.QueryRowContext(ctx, `SELECT refcount FROM blobs WHERE sha256 = ?`, sha256Hex([]byte("bye"))).Scan(&ref); err != nil {
		t.Fatalf("查询 refcount: %v", err)
	}
	if ref != 0 {
		t.Errorf("refcount = %d, want 0", ref)
	}
	if err := s.DeleteFlow(ctx, f.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("重复删除应返回 ErrNotFound, got %v", err)
	}
}

func TestSplitSQL(t *testing.T) {
	src := `CREATE TABLE a (x TEXT DEFAULT '{"k":false}');
-- 注释里的分号不影响
CREATE TABLE b (y TEXT);`
	got := splitSQL(src)
	if len(got) != 2 {
		t.Fatalf("切分得到 %d 条, want 2: %#v", len(got), got)
	}
	if got[0] != `CREATE TABLE a (x TEXT DEFAULT '{"k":false}')` {
		t.Errorf("第一条 = %q", got[0])
	}
}
