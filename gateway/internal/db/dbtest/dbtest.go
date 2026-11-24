// Package dbtest builds database files shaped like the ones Node's
// migrations make, for the gateway's tests. The schema is
// internal/db/testdata/schema.sql, which tests/unit/gateway-db-manifest.test.js
// holds to src/lib/db/schema.js.
package dbtest

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// Options for New.
type Options struct {
	// Driver is recorded as _meta.dbDriver ("better-sqlite3" when empty, "-"
	// for none).
	Driver string
	// SchemaVersion is _meta.schemaVersion (6 when 0, none when negative).
	SchemaVersion int
	// JournalMode is the file's journal mode ("wal" when empty).
	JournalMode string
	// Drop removes columns before the file is handed over, as "table.column".
	Drop []string
	// Path is where to make the file (a temp dir's data.sqlite when empty).
	Path string
}

// SchemaSQL is Node's CREATE statements.
func SchemaSQL(t testing.TB) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "testdata", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// New makes a migrated database file in a temp dir and returns its path and
// a connection playing Node (the other process), closed at cleanup.
func New(t testing.TB, o Options) (string, *sql.DB) {
	t.Helper()
	path := o.Path
	if path == "" {
		path = filepath.Join(t.TempDir(), "data.sqlite")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	node := Open(t, path)
	mode := o.JournalMode
	if mode == "" {
		mode = "wal"
	}
	Exec(t, node, "PRAGMA journal_mode = "+mode)
	Exec(t, node, SchemaSQL(t))
	version := o.SchemaVersion
	if version == 0 {
		version = 6
	}
	if version > 0 {
		Exec(t, node, `INSERT INTO _meta(key, value) VALUES('schemaVersion', ?)`, fmt.Sprint(version))
	}
	driver := o.Driver
	if driver == "" {
		driver = "better-sqlite3"
	}
	if driver != "-" {
		Exec(t, node, `INSERT INTO _meta(key, value) VALUES('dbDriver', ?)`, driver)
	}
	for _, d := range o.Drop {
		table, col, _ := strings.Cut(d, ".")
		Exec(t, node, fmt.Sprintf("ALTER TABLE %s DROP COLUMN %s", table, col))
	}
	return path, node
}

// Open opens path the way Node's adapters do (busy_timeout 5000, NORMAL,
// foreign keys), as one connection.
func Open(t testing.TB, path string) *sql.DB {
	t.Helper()
	node, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	node.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = node.Close() })
	return node
}

// Exec runs q on db and fails the test on an error.
func Exec(t testing.TB, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

// QueryString reads one text value.
func QueryString(t testing.TB, db *sql.DB, q string, args ...any) string {
	t.Helper()
	var s sql.NullString
	if err := db.QueryRow(q, args...).Scan(&s); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return s.String
}
