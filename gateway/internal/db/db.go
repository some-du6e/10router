// Package db is the gateway's access to the Node app server's SQLite file
// (docs/GO_GATEWAY.md, "SQLite sharing" and "Config sync"). Node owns the
// schema and checkpoints the WAL; the gateway only reads, and writes the
// fields the doc's table gives it, in short BEGIN IMMEDIATE transactions that
// read the row fresh. Rows it writes are the text Node writes (package jsjson).
//
// Connections: one writer (BEGIN IMMEDIATE, busy_timeout 5000) and a small
// pool of query_only readers, all with synchronous=NORMAL, foreign_keys=ON and
// automatic checkpoints off. journal_mode is never set: Node puts the file in
// WAL mode and that persists; the schema guard refuses a file that isn't.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	// Local dates (usageDaily keys) must match Node's even in an image
	// without zoneinfo: Node's ICU knows every zone, so Go carries its own.
	_ "time/tzdata"

	// Pure Go SQLite: the image is Alpine and the gateway builds without cgo.
	_ "modernc.org/sqlite"
)

// BusyTimeout is schema.js's busy_timeout.
const BusyTimeout = 5000 * time.Millisecond

// DefaultReaders is the reader pool size.
const DefaultReaders = 4

// Options for Open.
type Options struct {
	// Readers is the reader pool size (DefaultReaders when 0).
	Readers int
	// Now is the clock for timestamps the gateway writes (time.Now when nil).
	Now func() time.Time
}

// DB is an open database: the writer, the readers, and once Watch runs, the
// guard status and the config snapshot.
type DB struct {
	writer  *sql.DB
	readers *sql.DB
	w       *writer
	now     func() time.Time

	status   atomic.Pointer[Status]
	snapshot atomic.Pointer[Snapshot]
	// lastErr is the watcher's latest poll or reload error ("" after a good poll).
	lastErr atomic.Value

	watchMu   sync.Mutex
	watching  bool
	stopWatch context.CancelFunc
	watchDone chan struct{}
	stats     watchStats
	// loadedAt is when the last snapshot loaded (UnixNano), ttl Watch's TTL.
	loadedAt atomic.Int64
	ttl      atomic.Int64
}

// DataFile is where Node keeps its database: DATA_DIR/db/data.sqlite, else
// ~/.9router/db/data.sqlite (the directory name kept for existing installs),
// as src/lib/dataDir.js and src/lib/db/paths.js resolve it.
func DataFile(getenv func(string) string) (string, error) {
	dir := getenv("DATA_DIR")
	// getDataDir's fallbacks: a Unix path on Windows, and a DATA_DIR it can't
	// create for lack of permission, both mean the default directory.
	if dir != "" && runtime.GOOS == "windows" && strings.HasPrefix(dir, "/") {
		dir = ""
	}
	if dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			if !errors.Is(err, fs.ErrPermission) {
				return "", err
			}
			dir = ""
		}
	}
	if dir == "" {
		if runtime.GOOS == "windows" {
			appData := getenv("APPDATA")
			if appData == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return "", err
				}
				appData = filepath.Join(home, "AppData", "Roaming")
			}
			dir = filepath.Join(appData, "9router")
		} else {
			home := getenv("HOME")
			if home == "" {
				var err error
				if home, err = os.UserHomeDir(); err != nil {
					return "", err
				}
			}
			dir = filepath.Join(home, ".9router")
		}
	}
	return filepath.Join(dir, "db", "data.sqlite"), nil
}

// dsn builds the modernc.org/sqlite DSN: a file: URI opened read-write
// without create (the gateway never makes the file; Node does), and the
// per-connection pragmas.
func dsn(path string, extra url.Values) string {
	q := url.Values{}
	q.Set("mode", "rw")
	q.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", BusyTimeout.Milliseconds()))
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Add("_pragma", "foreign_keys(1)")
	// Only Node checkpoints (its 60 s TRUNCATE timer). SQLite's automatic
	// checkpoint would otherwise run on the committing connection.
	q.Add("_pragma", "wal_autocheckpoint(0)")
	for k, vs := range extra {
		for _, v := range vs {
			q.Add(k, v)
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(abs), RawQuery: q.Encode()}
	if !strings.HasPrefix(u.Path, "/") {
		// Windows drive paths: file:///C:/...
		u.Path = "/" + u.Path
	}
	return u.String()
}

// Open opens Node's database file. It does not check the schema; Watch (or
// Check) does.
func Open(path string, o Options) (*DB, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("database file: %w", errors.Unwrap(err))
	}
	writer, err := sql.Open("sqlite", dsn(path, url.Values{"_txlock": {"immediate"}}))
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	writer.SetConnMaxIdleTime(0)

	readers, err := sql.Open("sqlite", dsn(path, url.Values{"_pragma": {"query_only(1)"}}))
	if err != nil {
		_ = writer.Close()
		return nil, err
	}
	n := o.Readers
	if n <= 0 {
		n = DefaultReaders
	}
	// One more for the watcher, which keeps its own connection (data_version
	// is per connection).
	readers.SetMaxOpenConns(n + 1)
	readers.SetMaxIdleConns(n + 1)

	now := o.Now
	if now == nil {
		now = time.Now
	}
	d := &DB{writer: writer, readers: readers, w: newWriter(writer), now: now}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := writer.PingContext(ctx); err != nil {
		_ = d.Close()
		return nil, err
	}
	if err := readers.PingContext(ctx); err != nil {
		_ = d.Close()
		return nil, err
	}
	return d, nil
}

// Close runs the writes already queued, then closes every connection. If no
// other process has the file open (Node already exited), SQLite checkpoints
// on the last close; while Node runs it can't, so the gateway never
// checkpoints under Node.
func (d *DB) Close() error {
	d.watchMu.Lock()
	stop, done := d.stopWatch, d.watchDone
	d.watchMu.Unlock()
	if stop != nil {
		stop()
		<-done
	}
	d.w.close()
	return errors.Join(d.readers.Close(), d.writer.Close())
}

// writeTx queues fn for the writer goroutine (writer.go), which runs it in a
// BEGIN IMMEDIATE transaction, possibly with other queued writes, inside a
// savepoint of its own: an error rolls back fn's changes only. It returns
// fn's error, or the commit's, and an error only for a write that didn't land
// (one whose transaction SQLite rolled back is failed with all the others in
// it), so a caller never retries one that did. A write whose ctx ends before
// it starts is skipped with ctx's error; once started it runs to its end.
func (d *DB) writeTx(ctx context.Context, fn func(ctx context.Context, tx *sql.Tx) error) error {
	return d.w.submit(ctx, fn)
}

// readTx runs fn in one short read transaction on a reader, so its reads see
// one snapshot. It never outlives fn.
func (d *DB) readTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := d.readers.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	return fn(tx)
}

// querier is what both *sql.DB and *sql.Tx offer.
type querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// bumpConfigGeneration is helpers/configGeneration.js's bump, for the config
// writes the gateway makes (a node's droppedBetas, a connection turned off).
const bumpConfigGenerationSQL = `INSERT INTO _meta(key, value) VALUES('configGeneration', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`

func bumpConfigGeneration(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, bumpConfigGenerationSQL)
	return err
}

// IsBusy reports whether err is SQLite's "database is locked" (SQLITE_BUSY),
// which the share rules say must never surface.
func IsBusy(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "SQLITE_BUSY") || strings.Contains(s, "database is locked")
}
