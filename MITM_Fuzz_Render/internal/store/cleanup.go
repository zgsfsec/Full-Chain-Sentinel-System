package store

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"strings"
)

// DeleteProxyFlows removes only captured traffic. The writer lock also covers blob
// creation, so files cannot be reclaimed between an insert's file and SQL writes.
func (s *Store) DeleteProxyFlows(ctx context.Context, ids []string) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	where := "source = 'proxy'"
	args := []any{}
	if ids != nil {
		where += " AND id IN (" + strings.TrimRight(strings.Repeat("?,", len(ids)), ",") + ")"
		for _, id := range ids {
			args = append(args, id)
		}
	}
	if _, err = tx.ExecContext(ctx, "CREATE TEMP TABLE cleanup_flows AS SELECT * FROM flows WHERE "+where, args...); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, `CREATE TEMP TABLE cleanup_refs AS SELECT sha, COUNT(*) AS n FROM (
		SELECT req_raw_sha AS sha FROM cleanup_flows UNION ALL SELECT resp_raw_sha FROM cleanup_flows
		UNION ALL SELECT req_body_sha FROM cleanup_flows UNION ALL SELECT resp_body_sha FROM cleanup_flows
		) WHERE sha IS NOT NULL GROUP BY sha`); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, "CREATE INDEX cleanup_refs_sha ON cleanup_refs(sha)"); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE blobs SET refcount = MAX(0, refcount - (
		SELECT n FROM cleanup_refs WHERE sha = blobs.sha256)) WHERE sha256 IN (SELECT sha FROM cleanup_refs)`); err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM flows WHERE id IN (SELECT id FROM cleanup_flows)")
	if err != nil {
		return 0, err
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, "DROP TABLE cleanup_flows"); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, "DROP TABLE cleanup_refs"); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT sha256 FROM blobs WHERE refcount = 0")
	if err != nil {
		return 0, err
	}
	var unused []string
	for rows.Next() {
		var sha string
		if err = rows.Scan(&sha); err != nil {
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
		if err = os.Remove(s.blobs.path(sha)); err != nil && !os.IsNotExist(err) {
			return 0, err
		}
		if _, err = s.db.ExecContext(ctx, "DELETE FROM blobs WHERE sha256 = ? AND refcount = 0", sha); err != nil {
			return 0, err
		}
	}
	return deleted, nil
}
