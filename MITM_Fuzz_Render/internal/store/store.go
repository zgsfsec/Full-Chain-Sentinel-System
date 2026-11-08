// Package store 提供 SQLite 元数据 + 内容寻址 blob 的持久化层。
//
// 设计要点（见 docs/SPEC-API.md §3）：
//   - 元数据与 body 分离：大包写文件，DB 只存 sha256；
//   - 时间统一 Unix 毫秒，索引即排序；
//   - 写入通过 writeMu 串行化，避免 SQLITE_BUSY；
//   - 迁移文件不可变，按版本号顺序单事务应用。
package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/chinaran404/replayd/internal/id"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Store 是进程内唯一的持久化入口。
type Store struct {
	db      *sql.DB
	blobs   *blobStore
	dataDir string

	writeMu   sync.Mutex
	cleanupMu sync.Mutex
	now       func() time.Time
}

// Open 打开（必要时创建）数据目录下的数据库并应用迁移。
func Open(ctx context.Context, dataDir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "blobs"), 0o700); err != nil {
		return nil, fmt.Errorf("store: 创建数据目录失败: %w", err)
	}

	dbPath := filepath.Join(dataDir, "replayd.db")
	dsn := "file:" + filepath.ToSlash(dbPath) +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)" +
		"&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: 打开数据库失败: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)

	s := &Store{
		db:      db,
		blobs:   &blobStore{root: filepath.Join(dataDir, "blobs")},
		dataDir: dataDir,
		now:     time.Now,
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: 连接数据库失败: %w", err)
	}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := s.ensureDefaultProject(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close 关闭数据库连接。
func (s *Store) Close() error { return s.db.Close() }

// DataDir 返回数据目录。
func (s *Store) DataDir() string { return s.dataDir }

// Ping 用于健康检查。
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

// ---------------------------------------------------------------- migrations

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("store: 初始化迁移表失败: %w", err)
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("store: 读取迁移目录失败: %w", err)
	}

	type migration struct {
		version int
		name    string
	}
	var list []migration
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(e.Name(), "_")
		if !ok {
			return fmt.Errorf("store: 迁移文件名不合法: %s", e.Name())
		}
		v, err := strconv.Atoi(prefix)
		if err != nil {
			return fmt.Errorf("store: 迁移版本号不合法: %s", e.Name())
		}
		list = append(list, migration{version: v, name: e.Name()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].version < list[j].version })

	var applied int
	err = s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&applied)
	if err != nil {
		return fmt.Errorf("store: 读取迁移版本失败: %w", err)
	}
	if len(list) > 0 && applied > list[len(list)-1].version {
		return fmt.Errorf("store: 数据库版本 %d 高于程序已知版本 %d，请升级 replayd 而不是降级运行",
			applied, list[len(list)-1].version)
	}

	for _, m := range list {
		if m.version <= applied {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + m.name)
		if err != nil {
			return fmt.Errorf("store: 读取迁移 %s 失败: %w", m.name, err)
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("store: 开启迁移事务失败: %w", err)
		}
		for _, stmt := range splitSQL(string(body)) {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("store: 应用迁移 %s 失败: %w", m.name, err)
			}
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`,
			m.version, s.now().UnixMilli()); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("store: 记录迁移版本失败: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: 提交迁移 %s 失败: %w", m.name, err)
		}
	}
	return nil
}

// splitSQL 按分号切分语句，正确跳过单引号字符串与 -- 行注释。
func splitSQL(src string) []string {
	var (
		out                           []string
		b                             strings.Builder
		inSingle, inDouble, inLineCmt bool
	)
	for i := 0; i < len(src); i++ {
		c := src[i]
		switch {
		case inLineCmt:
			b.WriteByte(c)
			if c == '\n' {
				inLineCmt = false
			}
		case inSingle:
			b.WriteByte(c)
			if c == '\'' {
				if i+1 < len(src) && src[i+1] == '\'' {
					b.WriteByte(src[i+1])
					i++
					continue
				}
				inSingle = false
			}
		case inDouble:
			b.WriteByte(c)
			if c == '"' {
				inDouble = false
			}
		default:
			switch {
			case c == '-' && i+1 < len(src) && src[i+1] == '-':
				inLineCmt = true
				b.WriteByte(c)
			case c == '\'':
				inSingle = true
				b.WriteByte(c)
			case c == '"':
				inDouble = true
				b.WriteByte(c)
			case c == ';':
				if stmt := strings.TrimSpace(b.String()); stmt != "" {
					out = append(out, stmt)
				}
				b.Reset()
			default:
				b.WriteByte(c)
			}
		}
	}
	if stmt := strings.TrimSpace(b.String()); stmt != "" {
		out = append(out, stmt)
	}
	return out
}

// ---------------------------------------------------------------- blob store

type blobStore struct{ root string }

func (b *blobStore) path(sha string) string {
	return filepath.Join(b.root, sha[0:2], sha[2:4], sha)
}

// put 写入内容寻址文件；已存在则直接复用。
func (b *blobStore) put(data []byte) (string, int64, error) {
	sha := sha256Hex(data)
	p := b.path(sha)
	if _, err := os.Stat(p); err == nil {
		return sha, int64(len(data)), nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return "", 0, fmt.Errorf("store: 创建 blob 目录失败: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return "", 0, fmt.Errorf("store: 创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return "", 0, fmt.Errorf("store: 写入 blob 失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return "", 0, fmt.Errorf("store: 关闭临时文件失败: %w", err)
	}
	if err := os.Rename(tmpName, p); err != nil {
		_ = os.Remove(tmpName)
		return "", 0, fmt.Errorf("store: 落盘 blob 失败: %w", err)
	}
	return sha, int64(len(data)), nil
}

func (b *blobStore) get(sha string) ([]byte, error) {
	data, err := os.ReadFile(b.path(sha))
	if err != nil {
		return nil, fmt.Errorf("store: 读取 blob %s 失败: %w", sha, err)
	}
	return data, nil
}

// ---------------------------------------------------------------- projects

func (s *Store) ensureDefaultProject(ctx context.Context) error {
	var exists int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM projects`).Scan(&exists)
	if err != nil {
		return fmt.Errorf("store: 查询项目失败: %w", err)
	}
	if exists > 0 {
		return nil
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO projects(id, name, created_at) VALUES(?, 'default', ?)`,
		id.New("prj"), s.now().UnixMilli())
	if err != nil {
		return fmt.Errorf("store: 创建默认项目失败: %w", err)
	}
	return nil
}

// DefaultProjectID 返回默认项目 ID。
func (s *Store) DefaultProjectID(ctx context.Context) (string, error) {
	var pid string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM projects ORDER BY created_at LIMIT 1`).Scan(&pid)
	if err != nil {
		return "", fmt.Errorf("store: 获取默认项目失败: %w", err)
	}
	return pid, nil
}

// ---------------------------------------------------------------- helpers

func marshalJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}
