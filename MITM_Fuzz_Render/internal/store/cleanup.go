package store

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"runtime"
	"strings"
)

// DeleteProxyFlows deletes in bounded transactions. The rowid boundary and forward
// traversal retain captures inserted after cleanup starts, including rowid reuse
// after the final original row is deleted. Each committed batch is durable.
func (s *Store) DeleteProxyFlows(ctx context.Context, ids []string) (int64, error) {
	s.cleanupMu.Lock()
	defer s.cleanupMu.Unlock()
	var through int64
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(rowid), 0) FROM flows").Scan(&through); err != nil {
		return 0, err
	}
	var total, after int64
	for {
		deleted, last, err := s.deleteProxyBatch(ctx, ids, after, through)
		total += deleted
		if err != nil {
			return total, err
		}
		if deleted == 0 {
			break
		}
		after = last
		if _, err := s.collectUnusedBlobBatch(ctx); err != nil {
			return total, err
		}
		if after >= through {
			break
		}
		runtime.Gosched()
	}
	for {
		n, err := s.collectUnusedBlobBatch(ctx)
		if err != nil || n == 0 {
			return total, err
		}
		runtime.Gosched()
	}
}

func (s *Store) deleteProxyBatch(ctx context.Context, ids []string, after, through int64) (int64, int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, after, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, after, err
	}
	defer tx.Rollback()
	where := "source = 'proxy' AND rowid > ? AND rowid <= ?"
	table := "flows NOT INDEXED"
	args := []any{after, through}
	if ids != nil {
		table = "flows"
		if len(ids) == 0 {
			return 0, after, nil
		}
		where += " AND id IN (" + strings.TrimRight(strings.Repeat("?,", len(ids)), ",") + ")"
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT rowid, id, COALESCE(req_raw_sha,''), COALESCE(resp_raw_sha,''),
		COALESCE(req_body_sha,''), COALESCE(resp_body_sha,'') FROM `+table+` WHERE `+where+` ORDER BY rowid LIMIT 256`, args...)
	if err != nil {
		return 0, after, err
	}
	var selected []any
	refs := make(map[string]int)
	last := after
	for rows.Next() {
		var id, a, b, c, d string
		if err := rows.Scan(&last, &id, &a, &b, &c, &d); err != nil {
			rows.Close()
			return 0, after, err
		}
		selected = append(selected, id)
		for _, sha := range []string{a, b, c, d} {
			if sha != "" {
				refs[sha]++
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(selected) == 0 {
		return 0, after, err
	}
	for sha, n := range refs {
		if _, err := tx.ExecContext(ctx, "UPDATE blobs SET refcount = MAX(0, refcount - ?) WHERE sha256 = ?", n, sha); err != nil {
			return 0, after, err
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM flows WHERE id IN ("+strings.TrimRight(strings.Repeat("?,", len(selected)), ",")+")", selected...); err != nil {
		return 0, after, err
	}
	if err := tx.Commit(); err != nil {
		return 0, after, err
	}
	return int64(len(selected)), last, nil
}

// File creation and collection share writeMu. Release it every 64 files so new
// flows and artifacts can acquire references before the next collection batch.
func (s *Store) collectUnusedBlobBatch(ctx context.Context) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT sha256 FROM blobs WHERE refcount = 0 LIMIT 64")
	if err != nil {
		return 0, err
	}
	var unused []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			rows.Close()
			return 0, err
		}
		unused = append(unused, sha)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	for _, sha := range unused {
		if decoded, err := hex.DecodeString(sha); err != nil || len(decoded) != 32 {
			return 0, errors.New("invalid blob hash")
		}
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if err := os.Remove(s.blobs.path(sha)); err != nil && !os.IsNotExist(err) {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM blobs WHERE sha256 = ? AND refcount = 0", sha); err != nil {
			return 0, err
		}
	}
	return len(unused), tx.Commit()
}
