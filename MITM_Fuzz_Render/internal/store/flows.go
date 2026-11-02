package store

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/chinaran404/replayd/internal/id"
)

// ErrNotFound 表示资源不存在。
var ErrNotFound = errors.New("store: 资源不存在")

const flowColumns = `id, project_id, source, ts, duration_ms, method, scheme, host, port,
	path, COALESCE(query,''), COALESCE(http_version,''), status, req_headers, req_size,
	resp_headers, resp_size, COALESCE(tls,''), COALESCE(timings,''), COALESCE(error,''),
	COALESCE(tags,'[]'), COALESCE(note,''), created_at`

// Filter 是 flow 列表的查询条件；零值表示不过滤。
type Filter struct {
	ProjectID string
	Host      string
	Method    string
	Source    string
	Search    string
	Status    *int
	From      int64
	To        int64
	Limit     int
	Cursor    string
}

type scanner interface{ Scan(dest ...any) error }

func scanFlow(sc scanner) (*Flow, error) {
	var (
		f           Flow
		duration    sql.NullInt64
		status      sql.NullInt64
		reqHeaders  string
		respHeaders string
		tls         string
		timings     string
		errJSON     string
		tags        string
	)
	err := sc.Scan(
		&f.ID, &f.ProjectID, &f.Source, &f.TS, &duration, &f.Method, &f.Scheme,
		&f.Host, &f.Port, &f.Path, &f.Query, &f.HTTPVersion, &status,
		&reqHeaders, &f.ReqSize, &respHeaders, &f.RespSize,
		&tls, &timings, &errJSON, &tags, &f.Note, &f.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if duration.Valid {
		v := duration.Int64
		f.DurationMS = &v
	}
	if status.Valid {
		v := int(status.Int64)
		f.Status = &v
	}
	f.ReqHeaders = decodeHeaders(reqHeaders)
	f.RespHeaders = decodeHeaders(respHeaders)
	f.Tags = decodeTags(tags)
	if tls != "" {
		f.TLS = []byte(tls)
	}
	if timings != "" {
		f.Timings = []byte(timings)
	}
	if errJSON != "" {
		f.Error = []byte(errJSON)
	}
	return &f, nil
}

// InsertFlow 写入一条 flow：先落 blob，再写元数据；同一事务内维护引用计数。
func (s *Store) InsertFlow(ctx context.Context, f *Flow) error {
	if f.Source == "" {
		f.Source = "replay"
	}
	if f.ID == "" {
		f.ID = id.New("flw")
	}
	now := s.now().UnixMilli()
	if f.TS == 0 {
		f.TS = now
	}
	if f.CreatedAt == 0 {
		f.CreatedAt = now
	}
	if f.ProjectID == "" {
		pid, err := s.DefaultProjectID(ctx)
		if err != nil {
			return err
		}
		f.ProjectID = pid
	}

	// Coordinate file creation with garbage collection, not just metadata writes.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	type blobMeta struct {
		sha  string
		size int64
	}
	metas := make([]blobMeta, 0, 4)
	save := func(data []byte, dst *string) error {
		if len(data) == 0 {
			return nil
		}
		sha, size, err := s.blobs.put(data)
		if err != nil {
			return err
		}
		*dst = sha
		metas = append(metas, blobMeta{sha: sha, size: size})
		return nil
	}
	if err := save(f.ReqBody, &f.reqBodySHA); err != nil {
		return err
	}
	if err := save(f.ReqRaw, &f.reqRawSHA); err != nil {
		return err
	}
	if err := save(f.RespBody, &f.respBodySHA); err != nil {
		return err
	}
	if err := save(f.RespRaw, &f.respRawSHA); err != nil {
		return err
	}
	if f.ReqSize == 0 && len(f.ReqRaw) > 0 {
		f.ReqSize = int64(len(f.ReqRaw))
	}
	if f.RespSize == 0 && len(f.RespRaw) > 0 {
		f.RespSize = int64(len(f.RespRaw))
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, m := range metas {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO blobs(sha256, size, refcount, created_at) VALUES(?, ?, 0, ?)
			 ON CONFLICT(sha256) DO NOTHING`, m.sha, m.size, now); err != nil {
			return fmt.Errorf("store: 写入 blob 元数据失败: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?`, m.sha); err != nil {
			return fmt.Errorf("store: 更新 blob 引用失败: %w", err)
		}
	}

	_, err = tx.ExecContext(ctx, `INSERT INTO flows (
			id, project_id, source, ts, duration_ms, method, scheme, host, port, path, query,
			http_version, req_headers, req_body_sha, req_size, req_raw_sha, status, resp_headers,
			resp_body_sha, resp_size, resp_raw_sha, tls, timings, error, tags, note, created_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		f.ID, f.ProjectID, f.Source, f.TS, f.DurationMS, f.Method, f.Scheme, f.Host, f.Port,
		f.Path, f.Query, f.HTTPVersion, marshalHeaders(f.ReqHeaders), nullIfEmpty(f.reqBodySHA),
		f.ReqSize, nullIfEmpty(f.reqRawSHA), f.Status, marshalHeaders(f.RespHeaders),
		nullIfEmpty(f.respBodySHA), f.RespSize, nullIfEmpty(f.respRawSHA),
		nullIfEmpty(string(f.TLS)), nullIfEmpty(string(f.Timings)), nullIfEmpty(string(f.Error)),
		marshalJSON(f.Tags), f.Note, f.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("store: 写入 flow 失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交 flow 失败: %w", err)
	}
	return nil
}

// GetFlow 读取单条 flow；withBodies 为 true 时一并加载请求/响应体与原文。
func (s *Store) GetFlow(ctx context.Context, flowID string, withBodies bool) (*Flow, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+flowColumns+`,
		COALESCE(req_body_sha,''), COALESCE(req_raw_sha,''),
		COALESCE(resp_body_sha,''), COALESCE(resp_raw_sha,'')
		FROM flows WHERE id = ?`, flowID)

	var (
		f                                              Flow
		duration                                       sql.NullInt64
		status                                         sql.NullInt64
		reqHeaders                                     string
		respHeaders                                    string
		tls, timings, errJSON, tags                    string
		reqBodySHA, reqRawSHA, respBodySHA, respRawSHA string
	)
	err := row.Scan(
		&f.ID, &f.ProjectID, &f.Source, &f.TS, &duration, &f.Method, &f.Scheme,
		&f.Host, &f.Port, &f.Path, &f.Query, &f.HTTPVersion, &status,
		&reqHeaders, &f.ReqSize, &respHeaders, &f.RespSize,
		&tls, &timings, &errJSON, &tags, &f.Note, &f.CreatedAt,
		&reqBodySHA, &reqRawSHA, &respBodySHA, &respRawSHA,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: 读取 flow 失败: %w", err)
	}
	if duration.Valid {
		v := duration.Int64
		f.DurationMS = &v
	}
	if status.Valid {
		v := int(status.Int64)
		f.Status = &v
	}
	f.ReqHeaders = decodeHeaders(reqHeaders)
	f.RespHeaders = decodeHeaders(respHeaders)
	f.Tags = decodeTags(tags)
	f.TLS = rawOrNil(tls)
	f.Timings = rawOrNil(timings)
	f.Error = rawOrNil(errJSON)
	f.reqBodySHA, f.reqRawSHA = reqBodySHA, reqRawSHA
	f.respBodySHA, f.respRawSHA = respBodySHA, respRawSHA

	if withBodies {
		if f.ReqBody, err = s.loadBlob(f.reqBodySHA); err != nil {
			return nil, err
		}
		if f.ReqRaw, err = s.loadBlob(f.reqRawSHA); err != nil {
			return nil, err
		}
		if f.RespBody, err = s.loadBlob(f.respBodySHA); err != nil {
			return nil, err
		}
		if f.RespRaw, err = s.loadBlob(f.respRawSHA); err != nil {
			return nil, err
		}
	}
	return &f, nil
}

// ListFlows 按 (ts, id) 倒序返回一页结果与下一页游标。
// CountFlows 统计符合筛选条件的记录总数（忽略游标，用于前端显示"共 N 条"）。
func (s *Store) CountFlows(ctx context.Context, filter Filter) (int64, error) {
	where, args, err := s.flowWhere(ctx, filter, false)
	if err != nil {
		return 0, err
	}
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM flows WHERE `+where, args...).Scan(&total); err != nil {
		return 0, fmt.Errorf("store: 统计 flow 总数失败: %w", err)
	}
	return total, nil
}

// flowWhere 构造 WHERE 子句；withCursor=false 时忽略游标。
func (s *Store) flowWhere(ctx context.Context, filter Filter, withCursor bool) (string, []any, error) {
	var (
		where []string
		args  []any
	)
	where = append(where, "project_id = ?")
	if filter.ProjectID != "" {
		args = append(args, filter.ProjectID)
	} else {
		pid, err := s.DefaultProjectID(ctx)
		if err != nil {
			return "", nil, err
		}
		args = append(args, pid)
	}
	if filter.Host != "" {
		where = append(where, "host = ?")
		args = append(args, filter.Host)
	}
	if filter.Method != "" {
		where = append(where, "method = ?")
		args = append(args, strings.ToUpper(filter.Method))
	}
	if filter.Source != "" {
		where = append(where, "source = ?")
		args = append(args, filter.Source)
	}
	if filter.Status != nil {
		where = append(where, "status = ?")
		args = append(args, *filter.Status)
	}
	if filter.Search != "" {
		where = append(where, "(host LIKE ? OR path LIKE ?)")
		like := "%" + filter.Search + "%"
		args = append(args, like, like)
	}
	if filter.From > 0 {
		where = append(where, "ts >= ?")
		args = append(args, filter.From)
	}
	if filter.To > 0 {
		where = append(where, "ts <= ?")
		args = append(args, filter.To)
	}
	if withCursor && filter.Cursor != "" {
		ts, cid, err := decodeCursor(filter.Cursor)
		if err != nil {
			return "", nil, fmt.Errorf("store: 游标不合法: %w", err)
		}
		where = append(where, "(ts < ? OR (ts = ? AND id < ?))")
		args = append(args, ts, ts, cid)
	}

	return strings.Join(where, " AND "), args, nil
}

func (s *Store) ListFlows(ctx context.Context, filter Filter) ([]*Flow, string, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}

	where, args, err := s.flowWhere(ctx, filter, true)
	if err != nil {
		return nil, "", err
	}

	q := `SELECT ` + flowColumns + ` FROM flows WHERE ` + where +
		` ORDER BY ts DESC, id DESC LIMIT ?`
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, "", fmt.Errorf("store: 查询 flow 列表失败: %w", err)
	}
	defer rows.Close()

	out := make([]*Flow, 0, limit)
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("store: 解析 flow 行失败: %w", err)
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("store: 遍历 flow 失败: %w", err)
	}

	var next string
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		next = encodeCursor(last.TS, last.ID)
	}
	return out, next, nil
}

// DeleteFlow 删除一条 flow 并递减其 blob 引用计数。
func (s *Store) DeleteFlow(ctx context.Context, flowID string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var shas []string
	rows, err := tx.QueryContext(ctx, `SELECT COALESCE(req_body_sha,''), COALESCE(req_raw_sha,''),
		COALESCE(resp_body_sha,''), COALESCE(resp_raw_sha,'') FROM flows WHERE id = ?`, flowID)
	if err != nil {
		return fmt.Errorf("store: 查询 flow blob 失败: %w", err)
	}
	for rows.Next() {
		var a, b, c, d string
		if err := rows.Scan(&a, &b, &c, &d); err != nil {
			_ = rows.Close()
			return fmt.Errorf("store: 解析 flow blob 失败: %w", err)
		}
		for _, sha := range []string{a, b, c, d} {
			if sha != "" {
				shas = append(shas, sha)
			}
		}
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("store: 遍历 flow blob 失败: %w", err)
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM flows WHERE id = ?`, flowID)
	if err != nil {
		return fmt.Errorf("store: 删除 flow 失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	for _, sha := range shas {
		if _, err := tx.ExecContext(ctx,
			`UPDATE blobs SET refcount = MAX(refcount - 1, 0) WHERE sha256 = ?`, sha); err != nil {
			return fmt.Errorf("store: 更新 blob 引用失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交删除失败: %w", err)
	}
	return nil
}

// CountFlows 返回 flow 总数。
func (s *Store) CountAllFlows(ctx context.Context) (int64, error) {
	var n int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM flows`).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: 统计 flow 失败: %w", err)
	}
	return n, nil
}

func (s *Store) loadBlob(sha string) ([]byte, error) {
	if sha == "" {
		return nil, nil
	}
	return s.blobs.get(sha)
}

func nullIfEmpty(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func rawOrNil(v string) []byte {
	if v == "" {
		return nil
	}
	return []byte(v)
}

// ---------------------------------------------------------------- cursors

func encodeCursor(ts int64, flowID string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(ts, 10) + "|" + flowID))
}

func decodeCursor(v string) (int64, string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil {
		return 0, "", err
	}
	tsStr, idStr, ok := strings.Cut(string(raw), "|")
	if !ok || idStr == "" {
		return 0, "", errors.New("游标格式错误")
	}
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		return 0, "", err
	}
	return ts, idStr, nil
}
