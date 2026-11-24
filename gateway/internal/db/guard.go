package db

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"
)

//go:embed manifest.json
var manifestJSON []byte

// Manifest is what this gateway build can read: the highest migration it
// knows, the drivers whose file it may share, and the columns it uses.
type Manifest struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Drivers       []string            `json:"drivers"`
	Tables        map[string][]string `json:"tables"`
}

// Built is the manifest compiled into this binary.
var Built = func() Manifest {
	var m Manifest
	if err := json.Unmarshal(manifestJSON, &m); err != nil {
		panic(fmt.Sprintf("db: manifest.json: %v", err))
	}
	return m
}()

// Status is the schema guard's answer: may the gateway serve natively on
// this database, and if not, why.
type Status struct {
	Ready bool `json:"ready"`
	// Reason says why native routes are off (empty when Ready).
	Reason        string    `json:"reason,omitempty"`
	SchemaVersion int       `json:"schemaVersion"`
	Driver        string    `json:"driver,omitempty"`
	CheckedAt     time.Time `json:"checkedAt"`
}

// Check runs the schema guard once: the file is in WAL mode, Node recorded a
// driver whose file can be shared, the schema is no newer than Built knows,
// and every column Built uses exists. Extra tables and columns are fine.
func (d *DB) Check(ctx context.Context) Status {
	st := Status{CheckedAt: time.Now()}
	err := d.readTx(ctx, func(tx *sql.Tx) error {
		var reason string
		reason, st.SchemaVersion, st.Driver = check(ctx, tx, Built)
		if reason != "" {
			return errors.New(reason)
		}
		return nil
	})
	if err != nil {
		st.Reason = err.Error()
		return st
	}
	st.Ready = true
	return st
}

func check(ctx context.Context, tx *sql.Tx, m Manifest) (reason string, version int, driver string) {
	var mode string
	if err := tx.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return "cannot read journal_mode: " + err.Error(), 0, ""
	}
	meta := map[string]string{}
	rows, err := tx.QueryContext(ctx, `SELECT key, value FROM _meta WHERE key IN ('schemaVersion', 'dbDriver')`)
	if err != nil {
		return "cannot read _meta: " + err.Error(), 0, ""
	}
	for rows.Next() {
		var k string
		var v sql.NullString
		if err := rows.Scan(&k, &v); err != nil {
			_ = rows.Close()
			return "cannot read _meta: " + err.Error(), 0, ""
		}
		meta[k] = v.String
	}
	if err := rows.Close(); err != nil {
		return "cannot read _meta: " + err.Error(), 0, ""
	}
	// migrate.js: parseInt(getMetaSync(adapter, "schemaVersion", "0"), 10) || 0
	version = int(jsParseInt(meta["schemaVersion"]))
	driver = meta["dbDriver"]

	switch {
	case driver == "sql.js":
		return "the app server runs on sql.js, which keeps the database in memory and rewrites the file, so it can't be shared", version, driver
	case driver == "":
		return "the app server recorded no database driver (_meta.dbDriver); it predates sharing", version, driver
	case !slices.Contains(m.Drivers, driver):
		return fmt.Sprintf("the app server's database driver %q is not one the gateway shares a file with", driver), version, driver
	}
	if !strings.EqualFold(mode, "wal") {
		return fmt.Sprintf("the database is in %s journal mode, not WAL", mode), version, driver
	}
	if version == 0 {
		return "the database has no schema version (_meta.schemaVersion)", version, driver
	}
	if version > m.SchemaVersion {
		return fmt.Sprintf("schema version %d is newer than this gateway knows (%d)", version, m.SchemaVersion), version, driver
	}

	tables := make([]string, 0, len(m.Tables))
	for t := range m.Tables {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	for _, table := range tables {
		have, err := columns(ctx, tx, table)
		if err != nil {
			return fmt.Sprintf("cannot read table %s: %v", table, err), version, driver
		}
		if len(have) == 0 {
			return fmt.Sprintf("table %s is missing", table), version, driver
		}
		for _, col := range m.Tables[table] {
			if !have[col] {
				return fmt.Sprintf("table %s has no column %s", table, col), version, driver
			}
		}
	}
	return "", version, driver
}

func columns(ctx context.Context, q querier, table string) (map[string]bool, error) {
	// table comes from the manifest, never from the database or a client.
	rows, err := q.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		have[name] = true
	}
	return have, rows.Err()
}

// jsParseInt is parseInt(s, 10) for the integers Node stores as text in
// _meta: leading whitespace, a sign, then digits; none is NaN (returned as 0
// with ok false by jsParseIntOK).
func jsParseInt(s string) int64 {
	n, _ := jsParseIntOK(s)
	return n
}

func jsParseIntOK(s string) (int64, bool) {
	s = jsTrimLeft(s)
	neg := false
	if s != "" && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	var n int64
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		if n < (1<<62)/10 {
			n = n*10 + int64(s[i]-'0')
		}
		i++
	}
	if i == 0 {
		return 0, false
	}
	if neg {
		n = -n
	}
	return n, true
}
