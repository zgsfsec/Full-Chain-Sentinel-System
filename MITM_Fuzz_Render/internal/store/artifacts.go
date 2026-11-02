package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/chinaran404/replayd/internal/id"
)

// 产物类型。
const (
	ArtifactScreenshotViewport = "screenshot-viewport"
	ArtifactScreenshotFull     = "screenshot-full"
	ArtifactText               = "text"
	ArtifactA11y               = "a11y"
	ArtifactHTML               = "html"
)

// Artifact 是一份落盘产物（截图/文本/无障碍树…）。
type Artifact struct {
	ID          string          `json:"id"`
	JobID       string          `json:"jobId,omitempty"`
	Kind        string          `json:"kind"`
	ContentType string          `json:"contentType"`
	Size        int64           `json:"size"`
	Meta        json.RawMessage `json:"meta,omitempty"`
	CreatedAt   int64           `json:"createdAt"`

	blobSHA string
}

// InsertArtifact 写入产物内容（blob）与元数据。
func (s *Store) InsertArtifact(ctx context.Context, a *Artifact, data []byte) error {
	if a.ID == "" {
		a.ID = id.New("art")
	}
	if a.Kind == "" {
		a.Kind = ArtifactText
	}
	if a.ContentType == "" {
		a.ContentType = "application/octet-stream"
	}
	if len(a.Meta) > 0 && !json.Valid(a.Meta) {
		return errors.New("store: artifact meta 不是合法 JSON")
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	sha, size, err := s.blobs.put(data)
	if err != nil {
		return err
	}
	a.blobSHA = sha
	a.Size = size
	if a.CreatedAt == 0 {
		a.CreatedAt = s.now().UnixMilli()
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `INSERT INTO blobs(sha256, size, refcount, created_at)
		VALUES(?, ?, 0, ?) ON CONFLICT(sha256) DO NOTHING`, sha, size, a.CreatedAt); err != nil {
		return fmt.Errorf("store: 写入 blob 元数据失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?`, sha); err != nil {
		return fmt.Errorf("store: 更新 blob 引用失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO artifacts
		(id, job_id, kind, content_type, blob_sha, size, meta, created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		a.ID, nullIfEmpty(a.JobID), a.Kind, a.ContentType, sha, size,
		nullIfEmpty(string(a.Meta)), a.CreatedAt); err != nil {
		return fmt.Errorf("store: 写入产物失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交产物失败: %w", err)
	}
	return nil
}

// GetArtifact 读取产物元数据与内容。
func (s *Store) GetArtifact(ctx context.Context, artifactID string) (*Artifact, []byte, error) {
	var (
		a    Artifact
		meta string
	)
	err := s.db.QueryRowContext(ctx, `SELECT id, COALESCE(job_id,''), kind, content_type,
		blob_sha, size, COALESCE(meta,''), created_at FROM artifacts WHERE id = ?`, artifactID).
		Scan(&a.ID, &a.JobID, &a.Kind, &a.ContentType, &a.blobSHA, &a.Size, &meta, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, fmt.Errorf("store: 读取产物失败: %w", err)
	}
	if meta != "" {
		a.Meta = json.RawMessage(meta)
	}
	data, err := s.blobs.get(a.blobSHA)
	if err != nil {
		return nil, nil, err
	}
	return &a, data, nil
}

// ListArtifacts 按时间倒序返回产物元数据（不含内容）。
func (s *Store) ListArtifacts(ctx context.Context, kind string, limit int) ([]*Artifact, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	query := `SELECT id, COALESCE(job_id,''), kind, content_type, blob_sha, size,
		COALESCE(meta,''), created_at FROM artifacts`
	args := []any{}
	if kind != "" {
		query += ` WHERE kind = ?`
		args = append(args, kind)
	}
	query += ` ORDER BY created_at DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: 查询产物失败: %w", err)
	}
	defer rows.Close()

	var out []*Artifact
	for rows.Next() {
		var (
			a    Artifact
			meta string
		)
		if err := rows.Scan(&a.ID, &a.JobID, &a.Kind, &a.ContentType, &a.blobSHA,
			&a.Size, &meta, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("store: 解析产物失败: %w", err)
		}
		if meta != "" {
			a.Meta = json.RawMessage(meta)
		}
		out = append(out, &a)
	}
	return out, rows.Err()
}

// DeleteArtifact 删除产物（手动清理用；默认永久保留）。
func (s *Store) DeleteArtifact(ctx context.Context, artifactID string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: 开启事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var sha string
	err = tx.QueryRowContext(ctx, `SELECT blob_sha FROM artifacts WHERE id = ?`, artifactID).Scan(&sha)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store: 查询产物失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifacts WHERE id = ?`, artifactID); err != nil {
		return fmt.Errorf("store: 删除产物失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE blobs SET refcount = MAX(refcount - 1, 0) WHERE sha256 = ?`, sha); err != nil {
		return fmt.Errorf("store: 更新 blob 引用失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: 提交删除失败: %w", err)
	}
	return nil
}

// CountArtifacts 返回产物总数与总字节数。
func (s *Store) CountArtifacts(ctx context.Context) (count int64, bytes int64, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COUNT(1), COALESCE(SUM(size),0) FROM artifacts`).Scan(&count, &bytes)
	if err != nil {
		return 0, 0, fmt.Errorf("store: 统计产物失败: %w", err)
	}
	return count, bytes, nil
}
