package db

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

var fixedNow = time.Date(2026, 3, 1, 12, 0, 0, 123_000_000, time.UTC)

const fixedISO = "2026-03-01T12:00:00.123Z"

// zwnbsp is U+FEFF, which String#trim removes (it is JavaScript whitespace).
var zwnbsp = string(rune(0xFEFF))

func open(t *testing.T, o dbtest.Options) (*DB, *sql.DB, string) {
	t.Helper()
	path, node := dbtest.New(t, o)
	d, err := Open(path, Options{Now: func() time.Time { return fixedNow }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d, node, path
}

func obj(t *testing.T, s string) *jsjson.Object {
	t.Helper()
	o, err := jsjson.ParseObject([]byte(s))
	if err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return o
}

func val(t *testing.T, s string) any {
	t.Helper()
	v, err := jsjson.Parse([]byte(s))
	if err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return v
}

func eventually(t *testing.T, within time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s: not within %v", what, within)
}

func TestOpenNeverCreatesTheFile(t *testing.T) {
	if _, err := Open(t.TempDir()+"/missing.sqlite", Options{}); err == nil {
		t.Fatal("opened a database that doesn't exist")
	}
}

func TestDataFile(t *testing.T) {
	dataDir := t.TempDir()
	env := map[string]string{"DATA_DIR": dataDir, "HOME": "/home/x"}
	got, _ := DataFile(func(k string) string { return env[k] })
	if got != dataDir+"/db/data.sqlite" {
		t.Fatalf("DATA_DIR: %s", got)
	}
	delete(env, "DATA_DIR")
	if got, _ := DataFile(func(k string) string { return env[k] }); got != "/home/x/.9router/db/data.sqlite" {
		t.Fatalf("HOME: %s", got)
	}
}

func TestGuard(t *testing.T) {
	for _, c := range []struct {
		name   string
		opts   dbtest.Options
		reason string
	}{
		{"better-sqlite3", dbtest.Options{}, ""},
		{"node:sqlite", dbtest.Options{Driver: "node:sqlite"}, ""},
		{"bun:sqlite", dbtest.Options{Driver: "bun:sqlite"}, ""},
		{"an older schema with every column", dbtest.Options{SchemaVersion: 5}, ""},
		{"sql.js", dbtest.Options{Driver: "sql.js"}, "sql.js"},
		{"no driver recorded", dbtest.Options{Driver: "-"}, "no database driver"},
		{"an unknown driver", dbtest.Options{Driver: "duckdb"}, `"duckdb"`},
		{"a newer schema", dbtest.Options{SchemaVersion: 7}, "schema version 7 is newer than this gateway knows (6)"},
		{"no schema version", dbtest.Options{SchemaVersion: -1}, "no schema version"},
		{"a missing column", dbtest.Options{Drop: []string{"apiKeys.allowedModels"}}, "table apiKeys has no column allowedModels"},
		{"rollback journal", dbtest.Options{JournalMode: "delete"}, "delete journal mode"},
	} {
		t.Run(c.name, func(t *testing.T) {
			d, _, _ := open(t, c.opts)
			st := d.Check(context.Background())
			if c.reason == "" {
				if !st.Ready || st.Reason != "" {
					t.Fatalf("not ready: %+v", st)
				}
				return
			}
			if st.Ready || !strings.Contains(st.Reason, c.reason) {
				t.Fatalf("got %+v, want a reason with %q", st, c.reason)
			}
		})
	}
}

func TestGuardAcceptsExtraTablesAndColumns(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	dbtest.Exec(t, node, `ALTER TABLE apiKeys ADD COLUMN somethingNew TEXT`)
	dbtest.Exec(t, node, `CREATE TABLE brandNew (id TEXT PRIMARY KEY)`)
	if st := d.Check(context.Background()); !st.Ready {
		t.Fatalf("extra schema refused: %+v", st)
	}
}

func TestBuiltManifestMatchesTheDoc(t *testing.T) {
	if Built.SchemaVersion != 6 || len(Built.Tables) != 11 {
		t.Fatalf("manifest: %+v", Built)
	}
	// The scopes loadKV reads are the manifest's (which Node's test holds to CONFIG_KV_SCOPES).
	if strings.Join(Built.KVScopes, ",") != "modelAliases,pricing,customModels" {
		t.Fatalf("kv scopes: %v", Built.KVScopes)
	}
}

func TestWatchReloadsOnAGenerationChangeOnly(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var reloads atomic.Int64
	if err := d.Watch(ctx, WatchOptions{PollInterval: 20 * time.Millisecond, TTL: time.Hour, OnReload: func(*Snapshot) { reloads.Add(1) }}); err != nil {
		t.Fatal(err)
	}
	s := d.Snapshot()
	if s == nil || s.Generation != 0 || !s.Settings.Bool("requireApiKey") {
		t.Fatalf("first snapshot: %+v", s)
	}
	if reloads.Load() != 1 {
		t.Fatalf("reloads after the first load: %d", reloads.Load())
	}

	// A usage write changes data_version but not the generation.
	dbtest.Exec(t, node, `INSERT INTO usageHistory(timestamp) VALUES('x')`)
	eventually(t, 2*time.Second, "the change is seen", func() bool { return d.Stats().Changes >= 2 })
	time.Sleep(60 * time.Millisecond)
	if reloads.Load() != 1 {
		t.Fatalf("a usage write reloaded the snapshot (%d)", reloads.Load())
	}

	dbtest.Exec(t, node, `INSERT INTO settings(id, data) VALUES(1, '{"requireApiKey":false}')`)
	dbtest.Exec(t, node, bumpConfigGenerationSQL)
	eventually(t, 2*time.Second, "the new generation loads", func() bool {
		s := d.Snapshot()
		return s != nil && s.Generation == 1 && !s.Settings.Bool("requireApiKey")
	})
	if reloads.Load() != 2 {
		t.Fatalf("reloads: %d", reloads.Load())
	}
}

func TestWatchReloadsEveryTTL(t *testing.T) {
	d, _, _ := open(t, dbtest.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := d.Watch(ctx, WatchOptions{PollInterval: 20 * time.Millisecond, TTL: 100 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	eventually(t, 2*time.Second, "TTL reloads", func() bool { return d.Stats().Reloads >= 3 })
}

func TestWatchTurnsNativeOffWhenTheSchemaChanges(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var statuses []Status
	statusCh := make(chan Status, 8)
	if err := d.Watch(ctx, WatchOptions{PollInterval: 20 * time.Millisecond, TTL: time.Hour, OnStatus: func(s Status) { statusCh <- s }}); err != nil {
		t.Fatal(err)
	}
	statuses = append(statuses, <-statusCh)
	if !statuses[0].Ready {
		t.Fatalf("first status: %+v", statuses[0])
	}
	dbtest.Exec(t, node, `ALTER TABLE combos DROP COLUMN kind`)
	select {
	case st := <-statusCh:
		if st.Ready || !strings.Contains(st.Reason, "table combos has no column kind") {
			t.Fatalf("after the change: %+v", st)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the schema change was not noticed")
	}
	if d.Snapshot() != nil {
		t.Fatal("a snapshot is served while the schema can't be read")
	}
	// Unchanged answers are not reported again.
	time.Sleep(100 * time.Millisecond)
	if len(statusCh) != 0 {
		t.Fatalf("status repeated: %+v", <-statusCh)
	}
}

func TestSnapshotReadsConfig(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	dbtest.Exec(t, node, `INSERT INTO settings(id, data) VALUES(1, '{"comboStrategy":"round-robin","mitmEnabled":true,"rtkEnabled":true,"zNew":1}')`)
	dbtest.Exec(t, node, `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES('c1', 'fast', NULL, '["a/m1","b/m2"]', 't', 't')`)
	dbtest.Exec(t, node, `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES('openai-compatible-chat-1', 'openai-compatible', 'N', '{"prefix":"oc","baseUrl":"http://u","apiType":"chat","droppedBetas":["x"],"modelRoutes":{"m":"anthropic"},"id":"stale"}', 't', 't')`)
	dbtest.Exec(t, node, `INSERT INTO apiKeys(id, key, name, isActive, createdAt, budgetUsd, allowedModels, spentUsd, spendOffsetUsd, limitHold) VALUES('k1', 'sk-a', 'A', 1, 't', 5, '["fast",3,"m"]', 1.2345678, 0.2, 0)`)
	dbtest.Exec(t, node, `INSERT INTO kv(scope, key, value) VALUES('modelAliases', 'sonnet', '"oc/claude"'), ('pricing', 'oc', '{"m":{"input":1}}'), ('customModels', 'oc|m|llm', '{"providerAlias":"oc","id":"m","type":"llm"}'), ('disabledModels', 'oc', '["x"]')`)
	s, err := d.LoadSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.Settings.String("comboStrategy") != "round-robin" || s.Settings.Merged.Has("mitmEnabled") || s.Settings.Merged.Has("rtkEnabled") {
		t.Fatalf("settings: %s", s.Settings.Merged)
	}
	if keys := s.Settings.Merged.Keys(); keys[0] != "usageHubEnabled" || keys[len(keys)-1] != "zNew" {
		t.Fatalf("settings order: %v", keys)
	}
	if c := s.Combos["fast"]; c == nil || len(c.Models) != 2 || c.Kind != nil {
		t.Fatalf("combo: %+v", c)
	}
	n := s.Nodes["openai-compatible-chat-1"]
	if n == nil || n.Prefix() != "oc" || n.BaseURL() != "http://u" || n.APIType() != "chat" || n.DroppedBetas()[0] != "x" || n.ModelRoutes() == nil || n.Data.Has("id") {
		t.Fatalf("node: %+v", n)
	}
	k := s.APIKeys["sk-a"]
	if k == nil || *k.BudgetUsd != 5 || strings.Join(k.AllowedModels, ",") != "fast,m" || k.SpentUsd != 1.034568 || k.LimitHold == nil || *k.LimitHold {
		t.Fatalf("key: %+v", k)
	}
	if a, ok := s.Alias("sonnet"); !ok || a != "oc/claude" {
		t.Fatalf("alias: %q", a)
	}
	if s.Pricing.String() != `{"oc":{"m":{"input":1}}}` || len(s.CustomModels) != 1 {
		t.Fatalf("pricing %s, custom %v", s.Pricing, s.CustomModels)
	}
}

func TestAPIKeyByKeyReadsSpendFresh(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	dbtest.Exec(t, node, `INSERT INTO apiKeys(id, key, createdAt, allowedModels) VALUES('k1', 'sk-a', 't', '[]')`)
	k, err := d.APIKeyByKey(context.Background(), "sk-a")
	if err != nil || k == nil || k.AllowedModels != nil || k.BudgetUsd != nil || k.LimitHold != nil || !k.IsActive {
		t.Fatalf("%+v %v", k, err)
	}
	dbtest.Exec(t, node, `UPDATE apiKeys SET spentUsd = 2.5`)
	if k, _ = d.APIKeyByKey(context.Background(), "sk-a"); k.SpentUsd != 2.5 {
		t.Fatalf("spend not fresh: %v", k.SpentUsd)
	}
	if k, err = d.APIKeyByKey(context.Background(), "nope"); k != nil || err != nil {
		t.Fatalf("unknown key: %+v %v", k, err)
	}
}

func insertConn(t *testing.T, node *sql.DB, id, provider string, priority any, active int, data string) {
	t.Helper()
	dbtest.Exec(t, node, `INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, 'apikey', ?, ?, ?, ?, 'c', 'u')`,
		id, provider, id, priority, active, data)
}

func TestListConnectionsSortsLikeNode(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	insertConn(t, node, "p3", "p", 3, 1, `{}`)
	insertConn(t, node, "pnull", "p", nil, 1, `{}`)
	insertConn(t, node, "p1", "p", 1, 1, `{}`)
	insertConn(t, node, "p0", "p", 0, 1, `{}`)
	insertConn(t, node, "p2", "p", 2, 1, `{}`)
	insertConn(t, node, "off", "p", 1, 0, `{}`)
	insertConn(t, node, "other", "q", 1, 1, `{}`)
	active := true
	list, err := d.ListConnections(context.Background(), "p", &active)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, c := range list {
		ids = append(ids, c.ID)
	}
	if got := strings.Join(ids, ","); got != "p1,p2,p3,pnull,p0" {
		t.Fatalf("order: %s", got)
	}
}

func connData(t *testing.T, node *sql.DB, id string) string {
	return dbtest.QueryString(t, node, `SELECT data FROM providerConnections WHERE id = ?`, id)
}

func TestUpdateConnectionMergesOwnedFields(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	insertConn(t, node, "c1", "p", 1, 1, `{"apiKey":"k1","modelLock_m":"2026-01-01T00:00:00.000Z","providerSpecificData":{"baseUrl":"x"},"2":"index key"}`)
	ctx := context.Background()
	got, err := d.UpdateConnection(ctx, "c1", ConnectionUpdate{Set: []jsjson.Member{
		{Key: "modelLock_m", Value: "2026-03-01T12:05:00.000Z"},
		{Key: "modelLimit_m", Value: true},
		{Key: "modelNoHeaders_m", Value: nil},
		{Key: "providerReset_m", Value: nil},
		{Key: "testStatus", Value: "unavailable"},
		{Key: "lastError", Value: "rate limited"},
		{Key: "errorCode", Value: 429.0},
		{Key: "lastErrorAt", Value: fixedISO},
		{Key: "backoffLevel", Value: 1.0},
		{Key: "1", Value: nil},
	}})
	if !errors.Is(err, ErrNotOwned) || got != nil {
		t.Fatalf("an index key was accepted: %v", err)
	}
	got, err = d.UpdateConnection(ctx, "c1", ConnectionUpdate{Set: []jsjson.Member{
		{Key: "modelLock_m", Value: "2026-03-01T12:05:00.000Z"},
		{Key: "modelLimit_m", Value: true},
		{Key: "modelNoHeaders_m", Value: nil},
		{Key: "providerReset_m", Value: nil},
		{Key: "testStatus", Value: "unavailable"},
		{Key: "lastError", Value: "rate limited"},
		{Key: "errorCode", Value: 429.0},
		{Key: "lastErrorAt", Value: fixedISO},
		{Key: "backoffLevel", Value: 1.0},
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"2":"index key","apiKey":"k1","modelLock_m":"2026-03-01T12:05:00.000Z","providerSpecificData":{"baseUrl":"x"},"modelLimit_m":true,"modelNoHeaders_m":null,"providerReset_m":null,"testStatus":"unavailable","lastError":"rate limited","errorCode":429,"lastErrorAt":"2026-03-01T12:00:00.123Z","backoffLevel":1}`
	if data := connData(t, node, "c1"); data != want {
		t.Fatalf("data:\n%s\nwant\n%s", data, want)
	}
	if got.Data.String() != want || got.UpdatedAt != fixedISO {
		t.Fatalf("returned %s %s", got.Data, got.UpdatedAt)
	}
	if u := dbtest.QueryString(t, node, `SELECT updatedAt FROM providerConnections WHERE id = 'c1'`); u != fixedISO {
		t.Fatalf("updatedAt %s", u)
	}
	if g := dbtest.QueryString(t, node, `SELECT COALESCE((SELECT value FROM _meta WHERE key = 'configGeneration'), '0')`); g != "0" {
		t.Fatalf("a lock write bumped the generation to %s", g)
	}
	for _, bad := range []string{"apiKey", "isActive", "providerSpecificData", "authDemote_m", "autoDisabledAt", "modelLock_"} {
		if _, err := d.UpdateConnection(ctx, "c1", ConnectionUpdate{Set: []jsjson.Member{{Key: bad, Value: 1.0}}}); !errors.Is(err, ErrNotOwned) {
			t.Errorf("%s accepted: %v", bad, err)
		}
	}
	if c, err := d.UpdateConnection(ctx, "missing", ConnectionUpdate{}); c != nil || err != nil {
		t.Fatalf("missing row: %v %v", c, err)
	}
}

func TestUpdateConnectionDemoteIsCompareAndSwap(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	insertConn(t, node, "c1", "p", 1, 1, `{"apiKey":"k1","authDemote_m":{"count":1,"firstAt":"a"},"authDemote_o":{"demotedAt":"x","nextProbeAt":"2099-01-01T00:00:00.000Z","lease":1},"authDemote_q":{"demotedAt":"x","nextProbeAt":"2000-01-01T00:00:00.000Z"}}`)
	ctx := context.Background()
	stale := &Demote{Model: "m", From: val(t, `{"count":0}`), To: val(t, `{"count":9}`)}
	if _, err := d.UpdateConnection(ctx, "c1", ConnectionUpdate{Demote: stale}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(connData(t, node, "c1"), `"authDemote_m":{"count":1,"firstAt":"a"}`) {
		t.Fatalf("a stale from was applied: %s", connData(t, node, "c1"))
	}
	// From compares as JSON.stringify does: same keys, same order.
	ok := &Demote{Model: "m", From: val(t, `{"count":1,"firstAt":"a"}`), To: val(t, `{"count":2,"firstAt":"a","demotedAt":"now"}`),
		Data: []jsjson.Member{{Key: "lastError", Value: "m demoted"}}, ProbeNow: []string{"o", "q", "none"}}
	got, err := d.UpdateConnection(ctx, "c1", ConnectionUpdate{Demote: ok})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"apiKey":"k1","authDemote_m":{"count":2,"firstAt":"a","demotedAt":"now"},"authDemote_o":{"demotedAt":"x","nextProbeAt":"2026-03-01T12:00:00.123Z","lease":1},"authDemote_q":{"demotedAt":"x","nextProbeAt":"2000-01-01T00:00:00.000Z"},"lastError":"m demoted"}`
	if data := connData(t, node, "c1"); data != want || got.Data.String() != want {
		t.Fatalf("data:\n%s\nwant\n%s", data, want)
	}
	// A missing record is null to the compare.
	if _, err := d.UpdateConnection(ctx, "c1", ConnectionUpdate{Demote: &Demote{Model: "new", From: nil, To: val(t, `{"count":1}`)}}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(connData(t, node, "c1"), `"authDemote_new":{"count":1}}`) {
		t.Fatalf("null from: %s", connData(t, node, "c1"))
	}

	got, err = d.UpdateConnection(ctx, "c1", ConnectionUpdate{LiftDemote: "m", NoteServed: true})
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := got.Field("authDemote_m"); v != nil {
		t.Fatalf("not lifted: %v", v)
	}
	if v, _ := got.Field("authDemoteOkAt"); v != fixedISO {
		t.Fatalf("authDemoteOkAt %v", v)
	}
	// Lifting a model with no record writes nothing for it.
	got, _ = d.UpdateConnection(ctx, "c1", ConnectionUpdate{LiftDemote: "never"})
	if got.Data.Has("authDemote_never") {
		t.Fatal("lifted a record that wasn't there")
	}
}

func TestUpdateConnectionStaleKeyKeepsTheStreak(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	insertConn(t, node, "c1", "p", 1, 1, `{"apiKey":"new-key","authFailCount":1}`)
	insertConn(t, node, "c2", "p", 2, 1, `{}`)
	used := "old-key"
	got, err := d.UpdateConnection(context.Background(), "c1", ConnectionUpdate{
		Set:         []jsjson.Member{{Key: "authFailCount", Value: 5.0}, {Key: "authFailModels", Value: []any{"m"}}, {Key: "lastError", Value: "401"}},
		AutoDisable: &AutoDisable{At: fixedISO, Reason: "dead"},
		Demote:      &Demote{Model: "m", From: nil, To: val(t, `{"count":1}`)},
		APIKeyUsed:  &used,
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"apiKey":"new-key","authFailCount":1,"lastError":"401"}`; got.Data.String() != want || !got.IsActive {
		t.Fatalf("got %s active=%v, want %s", got.Data, got.IsActive, want)
	}
}

func TestUpdateConnectionAutoDisableKeepsTheLastKey(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	insertConn(t, node, "c1", "p", 1, 1, `{"apiKey":"k1"}`)
	insertConn(t, node, "c2", "p", 2, 0, `{}`)
	ctx := context.Background()
	used := "k1"
	off := &AutoDisable{At: fixedISO, Reason: "401 on m"}
	got, err := d.UpdateConnection(ctx, "c1", ConnectionUpdate{AutoDisable: off, APIKeyUsed: &used})
	if err != nil || !got.IsActive || got.Data.Has("autoDisabledAt") {
		t.Fatalf("the provider's last key was turned off: %+v %v", got, err)
	}
	dbtest.Exec(t, node, `UPDATE providerConnections SET isActive = 1 WHERE id = 'c2'`)
	got, err = d.UpdateConnection(ctx, "c1", ConnectionUpdate{AutoDisable: off, APIKeyUsed: &used})
	if err != nil || got.IsActive {
		t.Fatalf("not turned off: %+v %v", got, err)
	}
	if want := `{"apiKey":"k1","autoDisabledAt":"2026-03-01T12:00:00.123Z","autoDisabledReason":"401 on m"}`; connData(t, node, "c1") != want {
		t.Fatalf("data %s", connData(t, node, "c1"))
	}
	if a := dbtest.QueryString(t, node, `SELECT isActive FROM providerConnections WHERE id = 'c1'`); a != "0" {
		t.Fatalf("isActive %s", a)
	}
	if g := dbtest.QueryString(t, node, `SELECT value FROM _meta WHERE key = 'configGeneration'`); g != "1" {
		t.Fatalf("turning a key off must bump the generation: %s", g)
	}
}

func TestMergeDroppedBetas(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	insertConn(t, node, "c1", "n1", 1, 1, `{"apiKey":"k","providerSpecificData":{"baseUrl":"x","droppedBetas":["a"]}}`)
	dbtest.Exec(t, node, `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES('n1', 'anthropic-compatible', 'N', '{"prefix":"p","droppedBetas":["b"]}', 't', 't')`)
	ctx := context.Background()
	if err := d.MergeDroppedBetas(ctx, "c1", "n1", []string{"c", "a", " d ", "bad flag", zwnbsp + "e"}, false); err != nil {
		t.Fatal(err)
	}
	if want := `{"apiKey":"k","providerSpecificData":{"baseUrl":"x","droppedBetas":["a","c","d","e"]}}`; connData(t, node, "c1") != want {
		t.Fatalf("connection: %s", connData(t, node, "c1"))
	}
	if got := dbtest.QueryString(t, node, `SELECT data FROM providerNodes WHERE id = 'n1'`); got != `{"prefix":"p","droppedBetas":["b","c","a","d","e"]}` {
		t.Fatalf("node: %s", got)
	}
	if g := dbtest.QueryString(t, node, `SELECT value FROM _meta WHERE key = 'configGeneration'`); g != "2" {
		t.Fatalf("generation %s", g)
	}
	// A connection on its own endpoint leaves the node alone.
	if err := d.MergeDroppedBetas(ctx, "c1", "n1", []string{"own"}, true); err != nil {
		t.Fatal(err)
	}
	if got := dbtest.QueryString(t, node, `SELECT data FROM providerNodes WHERE id = 'n1'`); strings.Contains(got, "own") {
		t.Fatalf("node changed: %s", got)
	}
}

func TestWriteUsageMatchesNodesAggregate(t *testing.T) {
	saved := localZone
	zone := time.FixedZone("test", -8*3600)
	localZone = func() *time.Location { return zone }
	t.Cleanup(func() { localZone = saved })

	d, node, _ := open(t, dbtest.Options{})
	dbtest.Exec(t, node, `INSERT INTO apiKeys(id, key, createdAt) VALUES('k1', 'sk-1', 't')`)
	dbtest.Exec(t, node, `INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', '5')`)
	entries := []UsageEntry{
		{Timestamp: "2026-03-01T05:00:00.000Z", Provider: "prov", Model: "m1", ConnectionID: "c1", APIKey: "sk-1", Endpoint: "/v1/messages",
			Tokens: obj(t, `{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2}`), Cost: 0.1},
		{Timestamp: "2026-03-01T05:30:00.000Z", Provider: "prov", Model: "m1",
			Tokens: obj(t, `{"prompt_tokens":3,"completion_tokens":4}`), Cost: 0.2, Status: "error"},
	}
	if err := d.WriteUsage(context.Background(), entries); err != nil {
		t.Fatal(err)
	}
	// Both are 2026-02-28 at UTC-8.
	day := dbtest.QueryString(t, node, `SELECT data FROM usageDaily WHERE dateKey = '2026-02-28'`)
	want := `{"requests":2,"promptTokens":13,"completionTokens":9,"cost":0.30000000000000004,` +
		`"byProvider":{"prov":{"requests":2,"promptTokens":13,"completionTokens":9,"cachedTokens":2,"cost":0.30000000000000004}},` +
		`"byModel":{"m1|prov":{"requests":2,"promptTokens":13,"completionTokens":9,"cachedTokens":2,"cost":0.30000000000000004,"rawModel":"m1","provider":"prov"}},` +
		`"byAccount":{"c1":{"requests":1,"promptTokens":10,"completionTokens":5,"cachedTokens":2,"cost":0.1,"rawModel":"m1","provider":"prov"}},` +
		`"byApiKey":{"sk-1|m1|prov":{"requests":1,"promptTokens":10,"completionTokens":5,"cachedTokens":2,"cost":0.1,"rawModel":"m1","provider":"prov","apiKey":"sk-1"},` +
		`"local-no-key|m1|prov":{"requests":1,"promptTokens":3,"completionTokens":4,"cachedTokens":0,"cost":0.2,"rawModel":"m1","provider":"prov","apiKey":null}},` +
		`"byEndpoint":{"/v1/messages|m1|prov":{"requests":1,"promptTokens":10,"completionTokens":5,"cachedTokens":2,"cost":0.1,"endpoint":"/v1/messages","rawModel":"m1","provider":"prov"},` +
		`"Unknown|m1|prov":{"requests":1,"promptTokens":3,"completionTokens":4,"cachedTokens":0,"cost":0.2,"endpoint":"Unknown","rawModel":"m1","provider":"prov"}},` +
		`"cachedTokens":2}`
	if day != want {
		t.Fatalf("day:\n%s\nwant\n%s", day, want)
	}
	if n := dbtest.QueryString(t, node, `SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`); n != "7" {
		t.Fatalf("lifetime %s", n)
	}
	var spent float64
	var count int64
	var last string
	if err := node.QueryRow(`SELECT spentUsd, requestCount, lastUsedAt FROM apiKeys WHERE key = 'sk-1'`).Scan(&spent, &count, &last); err != nil {
		t.Fatal(err)
	}
	if spent != 0.1 || count != 1 || last != "2026-03-01T05:00:00.000Z" {
		t.Fatalf("spend %v %v %v", spent, count, last)
	}
	row := dbtest.QueryString(t, node, `SELECT json_array(provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) FROM usageHistory ORDER BY id DESC LIMIT 1`)
	if row != `["prov","m1",null,null,null,3,4,0.2,"error","{\"prompt_tokens\":3,\"completion_tokens\":4}","{}"]` {
		t.Fatalf("history row %s", row)
	}

	// Another batch on the same day reads the stored aggregate back.
	if err := d.WriteUsage(context.Background(), entries[:1]); err != nil {
		t.Fatal(err)
	}
	day = dbtest.QueryString(t, node, `SELECT data FROM usageDaily WHERE dateKey = '2026-02-28'`)
	if !strings.HasPrefix(day, `{"requests":3,"promptTokens":23,`) {
		t.Fatalf("second batch: %s", day)
	}
}

func TestUsageWriterBatches(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	w := d.NewUsageWriter(UsageWriterOptions{Interval: 10 * time.Millisecond, MaxBatch: 64})
	for i := 0; i < 1000; i++ {
		w.Add(UsageEntry{Timestamp: ISOTime(fixedNow), Provider: "p", Model: "m"})
	}
	if err := w.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM usageHistory`); n != "1000" {
		t.Fatalf("rows %s", n)
	}
	if n := dbtest.QueryString(t, node, `SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`); n != "1000" {
		t.Fatalf("lifetime %s", n)
	}
	if written, dropped, queued := w.Stats(); written != 1000 || dropped != 0 || queued != 0 {
		t.Fatalf("stats %d %d %d", written, dropped, queued)
	}
}

func TestSaveRequestDetails(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	var rows []RequestDetail
	for i, ts := range []string{"2026-03-01T00:00:01.000Z", "2026-03-01T00:00:02.000Z", "2026-03-01T00:00:03.000Z", "2026-03-01T00:00:04.000Z", "2026-03-01T00:00:05.000Z"} {
		rows = append(rows, RequestDetail{ID: ts + "-x-m", Timestamp: ts, Provider: "p", Model: "m", Status: "success",
			Latency: obj(t, `{"ttft":1}`), Request: val(t, `{"model":"m"}`), FullData: []byte{0x1f, 0x8b, byte(i)}})
	}
	rows[4].ErrorClass = "upstream"
	if err := d.SaveRequestDetails(context.Background(), rows, 3); err != nil {
		t.Fatal(err)
	}
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM requestDetails`); n != "3" {
		t.Fatalf("rows %s", n)
	}
	if oldest := dbtest.QueryString(t, node, `SELECT MIN(timestamp) FROM requestDetails`); oldest != "2026-03-01T00:00:03.000Z" {
		t.Fatalf("oldest %s", oldest)
	}
	data := dbtest.QueryString(t, node, `SELECT data FROM requestDetails WHERE timestamp = '2026-03-01T00:00:05.000Z'`)
	want := `{"id":"2026-03-01T00:00:05.000Z-x-m","provider":"p","model":"m","connectionId":null,"timestamp":"2026-03-01T00:00:05.000Z","status":"success","latency":{"ttft":1},"tokens":{},"request":{"model":"m"},"providerRequest":{},"providerResponse":{},"response":{},"errorClass":"upstream"}`
	if data != want {
		t.Fatalf("data:\n%s\nwant\n%s", data, want)
	}
	// A later save without a full copy keeps the stored one.
	again := rows[4]
	again.FullData, again.Status = nil, "error"
	if err := d.SaveRequestDetails(context.Background(), []RequestDetail{again}, 3); err != nil {
		t.Fatal(err)
	}
	if n := dbtest.QueryString(t, node, `SELECT length(fullData) FROM requestDetails WHERE id = ?`, again.ID); n != "3" {
		t.Fatalf("full copy lost: %s", n)
	}
}

func TestWritesWaitForNodesLock(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	conn, err := node.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	const hold = 300 * time.Millisecond
	go func() {
		time.Sleep(hold)
		_, _ = conn.ExecContext(context.Background(), "COMMIT")
	}()
	start := time.Now()
	if err := d.WriteUsage(context.Background(), []UsageEntry{{Timestamp: ISOTime(fixedNow), Model: "m"}}); err != nil {
		t.Fatalf("the write failed instead of waiting: %v", err)
	}
	waited := time.Since(start)
	t.Logf("waited %v for a %v lock", waited, hold)
	// The busy handler sleeps in short steps, not whole seconds.
	if waited < hold-20*time.Millisecond || waited > hold+400*time.Millisecond {
		t.Fatalf("waited %v for a %v lock", waited, hold)
	}
}

func TestConnectionsNeverCheckpointAndReadersCantWrite(t *testing.T) {
	d, _, path := open(t, dbtest.Options{})
	ctx := context.Background()
	var n int64
	if err := d.writer.QueryRowContext(ctx, "PRAGMA wal_autocheckpoint").Scan(&n); err != nil || n != 0 {
		t.Fatalf("writer wal_autocheckpoint %d %v", n, err)
	}
	if err := d.readers.QueryRowContext(ctx, "PRAGMA wal_autocheckpoint").Scan(&n); err != nil || n != 0 {
		t.Fatalf("reader wal_autocheckpoint %d %v", n, err)
	}
	if err := d.writer.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&n); err != nil || n != 5000 {
		t.Fatalf("busy_timeout %d %v", n, err)
	}
	if err := d.writer.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&n); err != nil || n != 1 {
		t.Fatalf("foreign_keys %d %v", n, err)
	}
	if err := d.writer.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&n); err != nil || n != 1 {
		t.Fatalf("synchronous %d %v", n, err)
	}
	if _, err := d.readers.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES('x', 'y')`); err == nil {
		t.Fatal("a reader wrote")
	}
	// Past SQLite's default 1000-page autocheckpoint the WAL keeps growing.
	big := strings.Repeat("x", 4000)
	var entries []UsageEntry
	for i := 0; i < 1500; i++ {
		entries = append(entries, UsageEntry{Timestamp: ISOTime(fixedNow), Model: "m", Tokens: obj(t, `{"pad":"`+big+`"}`)})
	}
	for i := 0; i < len(entries); i += 100 {
		if err := d.WriteUsage(ctx, entries[i:i+100]); err != nil {
			t.Fatal(err)
		}
	}
	info, err := os.Stat(path + "-wal")
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() < 1100*4096 {
		t.Fatalf("WAL is %d bytes: something checkpointed it", info.Size())
	}
}
