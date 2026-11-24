package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

func lockWrite(d *DB, id string, i int) error {
	_, err := d.UpdateConnection(context.Background(), id, ConnectionUpdate{Set: []jsjson.Member{
		{Key: "modelLock_m", Value: fmt.Sprint(i)}, {Key: "backoffLevel", Value: float64(i)},
	}})
	return err
}

func TestWriterPutsQueuedWritesInOneTransaction(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	for i := 0; i < 8; i++ {
		insertConn(t, node, fmt.Sprintf("c%d", i), "p", i+1, 1, `{}`)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 200)
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- lockWrite(d, fmt.Sprintf("c%d", i%8), i)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	st := d.LockStats()
	t.Logf("%+v", st)
	if st.Writes != 200 || st.Transactions >= 100 {
		t.Fatalf("200 concurrent writes took %d transactions", st.Transactions)
	}
}

// The property the stress job measures, in miniature: however busy the
// gateway's writer is, another process gets the write lock quickly.
func TestNodeGetsTheLockWhileTheGatewayIsBusy(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	insertConn(t, node, "c1", "p", 1, 1, `{}`)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; ctx.Err() == nil; i++ {
				if err := lockWrite(d, "c1", i); err != nil && !errors.Is(err, ErrClosed) {
					t.Error(err)
					return
				}
			}
		}()
	}
	conn, err := node.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var worst time.Duration
	for ctx.Err() == nil {
		start := time.Now()
		if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
			t.Fatalf("the other process didn't get the lock: %v", err)
		}
		worst = max(worst, time.Since(start))
		if _, err := conn.ExecContext(context.Background(), "UPDATE providerConnections SET name = 'node' WHERE id = 'c1'"); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.ExecContext(context.Background(), "COMMIT"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	wg.Wait()
	t.Logf("worst wait %v; gateway %+v", worst, d.LockStats())
	if worst > 500*time.Millisecond {
		t.Fatalf("the other process waited %v for the lock", worst)
	}
}

func TestAFailedWriteUndoesOnlyItself(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	ctx := context.Background()
	err := d.writeTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES('a', '1')`); err != nil {
			return err
		}
		return errors.New("no")
	})
	if err == nil || err.Error() != "no" {
		t.Fatalf("got %v", err)
	}
	err = d.writeTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		_, _ = tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES('b', '1')`)
		panic("boom")
	})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("panic: %v", err)
	}
	if err := d.writeTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES('c', '1')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if got := dbtest.QueryString(t, node, `SELECT group_concat(key) FROM (SELECT key FROM _meta WHERE key IN ('a', 'b', 'c') ORDER BY key)`); got != "c" {
		t.Fatalf("rows %q", got)
	}
}

func TestCloseRunsQueuedWritesThenRefuses(t *testing.T) {
	path, node := dbtest.New(t, dbtest.Options{})
	insertConn(t, node, "c1", "p", 1, 1, `{}`)
	d, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 50)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- lockWrite(d, "c1", i) }()
	}
	time.Sleep(5 * time.Millisecond)
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil && !errors.Is(err, ErrClosed) {
			t.Fatalf("a queued write failed: %v", err)
		}
	}
	if err := lockWrite(d, "c1", 0); !errors.Is(err, ErrClosed) {
		t.Fatalf("after Close: %v", err)
	}
}

func TestWatchRechecksWhenNodeRecordsAnotherDriver(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := d.Watch(ctx, WatchOptions{PollInterval: 20 * time.Millisecond, TTL: time.Hour}); err != nil {
		t.Fatal(err)
	}
	if !d.Status().Ready {
		t.Fatalf("first: %+v", d.Status())
	}
	// A Node restarted onto sql.js changes a row, not the schema.
	dbtest.Exec(t, node, `UPDATE _meta SET value = 'sql.js' WHERE key = 'dbDriver'`)
	eventually(t, 2*time.Second, "refused", func() bool { return strings.Contains(d.Status().Reason, "sql.js") })
	dbtest.Exec(t, node, `UPDATE _meta SET value = 'better-sqlite3' WHERE key = 'dbDriver'`)
	eventually(t, 2*time.Second, "ready again", func() bool { return d.Status().Ready && d.Snapshot() != nil })
	// A data-only migration moves schemaVersion alone.
	dbtest.Exec(t, node, `UPDATE _meta SET value = '7' WHERE key = 'schemaVersion'`)
	eventually(t, 2*time.Second, "newer schema refused", func() bool { return strings.Contains(d.Status().Reason, "schema version 7") })
}

func TestWatchRecoversOnceTheSchemaIsFixed(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{Drop: []string{"providerNodes.name"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := d.Watch(ctx, WatchOptions{PollInterval: 20 * time.Millisecond, TTL: 100 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if d.Status().Ready {
		t.Fatal("a missing column passed")
	}
	dbtest.Exec(t, node, `ALTER TABLE providerNodes ADD COLUMN name TEXT`)
	eventually(t, 2*time.Second, "ready once the column is back", func() bool { return d.Status().Ready })
}

func TestRequestDetailsKeepFullCopiesOnTheNewest25(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	var rows []RequestDetail
	for i := 0; i < 250; i++ {
		ts := fmt.Sprintf("2026-03-01T00:%02d:%02d.000Z", i/60, i%60)
		rows = append(rows, RequestDetail{ID: fmt.Sprintf("%s-%03d", ts, i), Timestamp: ts, FullData: []byte{1}})
	}
	if err := d.SaveRequestDetails(context.Background(), rows, 1000); err != nil {
		t.Fatal(err)
	}
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM requestDetails`); n != "250" {
		t.Fatalf("rows %s", n)
	}
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM requestDetails WHERE fullData IS NOT NULL`); n != "25" {
		t.Fatalf("full copies %s", n)
	}
	if oldest := dbtest.QueryString(t, node, `SELECT MIN(timestamp) FROM requestDetails WHERE fullData IS NOT NULL`); oldest != rows[225].Timestamp {
		t.Fatalf("oldest full copy %s", oldest)
	}
	// A typed nil payload is {} too, as truncateField makes it.
	r := RequestDetail{ID: "x", Timestamp: "t", Request: (*jsjson.Object)(nil)}
	if !strings.Contains(r.Record().String(), `"request":{}`) {
		t.Fatal(r.Record().String())
	}
}

func TestUsageEntriesWithoutProviderModelOrTime(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	if err := d.WriteUsage(context.Background(), []UsageEntry{{Tokens: obj(t, `{"input_tokens":2}`)}}); err != nil {
		t.Fatal(err)
	}
	// Node stamps a missing time with now, and keys an undefined model "undefined".
	row := dbtest.QueryString(t, node, `SELECT json_array(timestamp, provider, model, promptTokens) FROM usageHistory`)
	if row != `["`+fixedISO+`",null,null,2]` {
		t.Fatalf("row %s", row)
	}
	day := dbtest.QueryString(t, node, `SELECT data FROM usageDaily`)
	for _, want := range []string{
		`"byProvider":{}`,
		`"byModel":{"undefined":{"requests":1,"promptTokens":2,"completionTokens":0,"cachedTokens":0,"cost":0}}`,
		`"byApiKey":{"local-no-key|undefined|unknown":{"requests":1,"promptTokens":2,"completionTokens":0,"cachedTokens":0,"cost":0,"apiKey":null}}`,
		`"byEndpoint":{"Unknown|undefined|unknown":{"requests":1,"promptTokens":2,"completionTokens":0,"cachedTokens":0,"cost":0,"endpoint":"Unknown"}}`,
	} {
		if !strings.Contains(day, want) {
			t.Fatalf("day %s\nlacks %s", day, want)
		}
	}
}
