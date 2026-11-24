package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
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

// insertMeta is a write that adds one _meta row, after waiting for hold.
func insertMeta(key string, hold <-chan struct{}) func(context.Context, *sql.Tx) error {
	return func(ctx context.Context, tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES(?, '1')`, key); err != nil {
			return err
		}
		if hold != nil {
			<-hold
		}
		return nil
	}
}

// submitAsync queues fn and returns its result channel once it is queued.
func submitAsync(d *DB, fn func(context.Context, *sql.Tx) error) <-chan error {
	out := make(chan error, 1)
	go func() { out <- d.writeTx(context.Background(), fn) }()
	return out
}

func metaKeys(t *testing.T, node *sql.DB) string {
	return dbtest.QueryString(t, node, `SELECT COALESCE(group_concat(key), '') FROM (SELECT key FROM _meta WHERE key LIKE 'w_%' ORDER BY key)`)
}

func TestWritesInOneTransactionFailAlone(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	d.w.maxHold = time.Minute // keep everything queued in the first batch
	hold := make(chan struct{})
	first := submitAsync(d, insertMeta("w_a", hold))
	time.Sleep(20 * time.Millisecond)
	before := d.LockStats().Transactions
	failing := submitAsync(d, func(ctx context.Context, tx *sql.Tx) error {
		_, _ = tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES('w_b', '1')`)
		return errors.New("no")
	})
	panicking := submitAsync(d, func(ctx context.Context, tx *sql.Tx) error {
		_, _ = tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES('w_c', '1')`)
		panic("boom")
	})
	last := submitAsync(d, insertMeta("w_d", nil))
	time.Sleep(20 * time.Millisecond)
	close(hold)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-failing; err == nil || err.Error() != "no" {
		t.Fatalf("failing: %v", err)
	}
	if err := <-panicking; err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("panicking: %v", err)
	}
	if err := <-last; err != nil {
		t.Fatal(err)
	}
	if got := metaKeys(t, node); got != "w_a,w_d" {
		t.Fatalf("rows %q", got)
	}
	if n := d.LockStats().Transactions - before; n != 1 {
		t.Fatalf("the four writes took %d transactions", n)
	}
}

func TestALostTransactionFailsEveryWriteInIt(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	d.w.maxHold = time.Minute
	hold := make(chan struct{})
	first := submitAsync(d, insertMeta("w_a", hold))
	time.Sleep(20 * time.Millisecond)
	// As SQLITE_FULL or an I/O error would: SQLite ends the transaction itself.
	killer := submitAsync(d, func(ctx context.Context, tx *sql.Tx) error {
		_, _ = tx.ExecContext(ctx, `ROLLBACK`)
		return errors.New("disk full")
	})
	time.Sleep(10 * time.Millisecond)
	after := submitAsync(d, insertMeta("w_c", nil))
	time.Sleep(20 * time.Millisecond)
	close(hold)
	if err := <-first; !errors.Is(err, errTxLost) {
		t.Fatalf("a write in the lost transaction reported %v", err)
	}
	if err := <-killer; !errors.Is(err, errTxLost) {
		t.Fatalf("killer: %v", err)
	}
	// The write queued behind it runs in the next transaction.
	if err := <-after; err != nil {
		t.Fatalf("after: %v", err)
	}
	if got := metaKeys(t, node); got != "w_c" {
		t.Fatalf("rows %q: a write was reported failed but landed, or the reverse", got)
	}
}

func TestOneTransactionStopsTakingWritesAfterMaxHold(t *testing.T) {
	d, _, _ := open(t, dbtest.Options{})
	hold := make(chan struct{})
	first := submitAsync(d, insertMeta("w_first", hold))
	time.Sleep(20 * time.Millisecond)
	before := d.LockStats().Transactions
	var results []<-chan error
	for i := 0; i < 20; i++ {
		results = append(results, submitAsync(d, func(ctx context.Context, tx *sql.Tx) error {
			time.Sleep(4 * time.Millisecond)
			_, err := tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES(?, '1')`, fmt.Sprintf("w_%02d", i))
			return err
		}))
	}
	time.Sleep(20 * time.Millisecond)
	close(hold)
	<-first
	for _, r := range results {
		if err := <-r; err != nil {
			t.Fatal(err)
		}
	}
	st := d.LockStats()
	// 20 writes of 4 ms each, at most ~10 ms of them per transaction.
	if n := st.Transactions - before; n < 6 {
		t.Fatalf("20 slow writes in %d transactions: MaxWriteHold isn't bounding them (%+v)", n, st)
	}
}

func TestUsageWriterDropsARowThatCanNeverBeWritten(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	var reported []error
	w := d.NewUsageWriter(UsageWriterOptions{Interval: time.Hour, OnError: func(err error) { reported = append(reported, err) }})
	bad := jsjson.NewObject()
	bad.Set("input_tokens", map[string]any{}) // jsjson can't write it
	for i := 0; i < 5; i++ {
		e := UsageEntry{Timestamp: ISOTime(fixedNow), Model: "m"}
		if i == 2 {
			e.Tokens = bad
		}
		w.Add(e)
	}
	if err := w.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM usageHistory`); n != "4" {
		t.Fatalf("rows %s", n)
	}
	if w.Rejected() != 1 || len(reported) != 1 {
		t.Fatalf("rejected %d, reported %v", w.Rejected(), reported)
	}
}

func TestAnIsolateCutShortWritesNoRowTwice(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	// The first bad row's report cancels the flush: the rows after it are
	// still queued, and the bad one is not.
	w := d.NewUsageWriter(UsageWriterOptions{Interval: time.Hour, OnError: func(error) { cancel() }})
	bad := jsjson.NewObject()
	bad.Set("input_tokens", map[string]any{})
	// A good row lands before the bad one, so a regression that left landed
	// rows queued would write it twice.
	for i := 0; i < 5; i++ {
		e := UsageEntry{Timestamp: ISOTime(fixedNow), Model: "m"}
		if i == 1 {
			e.Tokens = bad
		}
		w.Add(e)
	}
	if err := w.Flush(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("flush: %v", err)
	}
	if _, _, queued := w.Stats(); queued != 3 {
		t.Fatalf("queued %d, want the 3 rows after the bad one", queued)
	}
	if err := w.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM usageHistory`); n != "4" {
		t.Fatalf("rows %s", n)
	}
	if n := dbtest.QueryString(t, node, `SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`); n != "4" {
		t.Fatalf("lifetime %s", n)
	}
	if written, _, _ := w.Stats(); written != 4 || w.Rejected() != 1 {
		t.Fatalf("written %d rejected %d", written, w.Rejected())
	}
}

func TestAWriteWhoseCallerHasGoneIsSkipped(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	hold := make(chan struct{})
	first := submitAsync(d, insertMeta("w_a", hold))
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	gone := make(chan error, 1)
	go func() { gone <- d.writeTx(ctx, insertMeta("w_b", nil)) }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	close(hold)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-gone; !errors.Is(err, context.Canceled) {
		t.Fatalf("gone: %v", err)
	}
	if got := metaKeys(t, node); got != "w_a" {
		t.Fatalf("rows %q", got)
	}
}

func TestABusyBeginFailsEveryQueuedWriteAtOnce(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	conn, err := node.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	start := time.Now()
	var results []<-chan error
	for i := 0; i < 5; i++ {
		results = append(results, submitAsync(d, insertMeta(fmt.Sprintf("w_%d", i), nil)))
		time.Sleep(5 * time.Millisecond)
	}
	for _, r := range results {
		if err := <-r; !IsBusy(err) {
			t.Fatalf("got %v, want SQLITE_BUSY", err)
		}
	}
	// One busy_timeout for all of them, not five.
	if took := time.Since(start); took > BusyTimeout+3*time.Second {
		t.Fatalf("five queued writes took %v to fail", took)
	}
}

func TestCloseStopsTheWatcher(t *testing.T) {
	path, _ := dbtest.New(t, dbtest.Options{})
	d, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Watch(context.Background(), WatchOptions{PollInterval: 10 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- d.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close hung on the watcher")
	}
	polls := d.Stats().Polls
	time.Sleep(50 * time.Millisecond)
	if d.Stats().Polls != polls {
		t.Fatal("the watcher kept polling after Close")
	}
}

func TestASnapshotOlderThanTwoTTLsIsNotServed(t *testing.T) {
	d, _, _ := open(t, dbtest.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := d.Watch(ctx, WatchOptions{PollInterval: time.Hour, TTL: time.Minute}); err != nil {
		t.Fatal(err)
	}
	if d.Snapshot() == nil {
		t.Fatal("no first snapshot")
	}
	old := time.Now().Add(-3 * time.Minute)
	d.loadedAt.Store(&old)
	if d.Snapshot() != nil {
		t.Fatal("a snapshot no reload has refreshed for 3 TTLs was served")
	}
}

func TestRequestDetailDefaultsAreNodes(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	rows := []RequestDetail{{Model: "vendor/model-3.5:x", Status: "success"}}
	if err := d.SaveRequestDetails(context.Background(), rows, 10); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^2026-03-01T12:00:00\.123Z-[0-9a-z]{6}-vendor-model-3-5-x$`).MatchString(rows[0].ID) || rows[0].Timestamp != fixedISO {
		t.Fatalf("id %q timestamp %q", rows[0].ID, rows[0].Timestamp)
	}
	// The id is made from now, not from a timestamp the row brings.
	dated := []RequestDetail{{Timestamp: "2020-01-01T00:00:00.000Z", Model: "m"}}
	if err := d.SaveRequestDetails(context.Background(), dated, 10); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dated[0].ID, fixedISO+"-") || dated[0].Timestamp != "2020-01-01T00:00:00.000Z" {
		t.Fatalf("id %q timestamp %q", dated[0].ID, dated[0].Timestamp)
	}
	// The ids stay in the caller's rows, so saving them again upserts.
	if err := d.SaveRequestDetails(context.Background(), rows, 10); err != nil {
		t.Fatal(err)
	}
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM requestDetails`); n != "2" {
		t.Fatalf("rows %s", n)
	}
}

func TestACounterWithoutAFieldGetsNullThenCounts(t *testing.T) {
	saved := localZone
	localZone = func() *time.Location { return time.UTC }
	t.Cleanup(func() { localZone = saved })
	d, node, _ := open(t, dbtest.Options{})
	// A row from before cachedTokens existed.
	dbtest.Exec(t, node, `INSERT INTO usageDaily(dateKey, data) VALUES('2026-03-01', '{"requests":1,"byProvider":{"p":{"requests":1,"promptTokens":1,"completionTokens":0,"cost":0}}}')`)
	e := UsageEntry{Timestamp: fixedISO, Provider: "p", Model: "m", Tokens: obj(t, `{"input_tokens":1,"cache_read_input_tokens":3}`)}
	if err := d.WriteUsage(context.Background(), []UsageEntry{e}); err != nil {
		t.Fatal(err)
	}
	day := dbtest.QueryString(t, node, `SELECT data FROM usageDaily`)
	// undefined + 3 is NaN, which JSON.stringify writes as null.
	if !strings.Contains(day, `"p":{"requests":2,"promptTokens":2,"completionTokens":0,"cost":0,"cachedTokens":null}`) {
		t.Fatalf("day %s", day)
	}
	if err := d.WriteUsage(context.Background(), []UsageEntry{e}); err != nil {
		t.Fatal(err)
	}
	// null + 3 is 3.
	if day = dbtest.QueryString(t, node, `SELECT data FROM usageDaily`); !strings.Contains(day, `"cachedTokens":3}`) {
		t.Fatalf("day %s", day)
	}
}

func TestUsageWriterStampsARowWhenItIsAdded(t *testing.T) {
	path, node := dbtest.New(t, dbtest.Options{})
	var clock atomic.Int64
	clock.Store(fixedNow.UnixNano())
	d, err := Open(path, Options{Now: func() time.Time { return time.Unix(0, clock.Load()) }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	w := d.NewUsageWriter(UsageWriterOptions{Interval: time.Hour})
	w.Add(UsageEntry{Model: "m"})
	clock.Add(int64(time.Hour)) // the flush comes later
	if err := w.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ts := dbtest.QueryString(t, node, `SELECT timestamp FROM usageHistory`); ts != fixedISO {
		t.Fatalf("timestamp %s: stamped at the flush, not at Add", ts)
	}
	// A row added after Close would never be flushed: it is counted, not held.
	w.Add(UsageEntry{Model: "late"})
	if _, dropped, queued := w.Stats(); dropped != 1 || queued != 0 {
		t.Fatalf("after Close: dropped %d queued %d", dropped, queued)
	}
}

func TestAddDuringCloseWritesNoRowTwice(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	w := d.NewUsageWriter(UsageWriterOptions{Interval: time.Hour, MaxBatch: 50})
	for i := 0; i < 600; i++ {
		w.Add(UsageEntry{Timestamp: ISOTime(fixedNow), Model: fmt.Sprintf("m-%d", i)})
	}
	// Handlers finishing while Close drains keep adding.
	stop := make(chan struct{})
	adding := make(chan struct{})
	go func() {
		defer close(adding)
		for i := 600; ; i++ {
			select {
			case <-stop:
				return
			default:
				w.Add(UsageEntry{Timestamp: ISOTime(fixedNow), Model: fmt.Sprintf("m-%d", i)})
			}
		}
	}()
	if err := w.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(stop)
	<-adding
	if err := w.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if dup := dbtest.QueryString(t, node, `SELECT COUNT(*) - COUNT(DISTINCT model) FROM usageHistory`); dup != "0" {
		t.Fatalf("%s rows written twice", dup)
	}
	written, _, queued := w.Stats()
	if n := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM usageHistory`); n != fmt.Sprint(written) || queued != 0 {
		t.Fatalf("rows %s, written %d, queued %d", n, written, queued)
	}
}

func TestACancelledWriteCostsNoGap(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	d.w.gap = 300 * time.Millisecond
	// A held write keeps the next two queued: a write whose caller then
	// goes, and a real one. After the held write commits, the real one
	// waits out one gap, not one for the cancelled write and one of its own.
	hold := make(chan struct{})
	first := submitAsync(d, insertMeta("w_a", hold))
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	gone := submitAsyncCtx(d, ctx, insertMeta("w_b", nil))
	time.Sleep(10 * time.Millisecond)
	cancel()
	live := submitAsync(d, insertMeta("w_c", nil))
	time.Sleep(10 * time.Millisecond)
	before := d.LockStats().Transactions
	start := time.Now()
	close(hold) // held past MaxWriteHold, so its transaction takes neither
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-live; err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Fatalf("the real write took %v: the cancelled one cost a gap", took)
	}
	if err := <-gone; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	// The real write had its own transaction, after a gap (it didn't ride along
	// in the held write's, which would prove nothing).
	if n := d.LockStats().Transactions - before; n != 2 {
		t.Fatalf("%d transactions, want the held write's and the real write's", n)
	}
	if got := metaKeys(t, node); got != "w_a,w_c" {
		t.Fatalf("rows %q", got)
	}
}

func submitAsyncCtx(d *DB, ctx context.Context, fn func(context.Context, *sql.Tx) error) <-chan error {
	out := make(chan error, 1)
	go func() { out <- d.writeTx(ctx, fn) }()
	return out
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
	ran := 0
	for err := range results {
		if err != nil && !errors.Is(err, ErrClosed) {
			t.Fatalf("a queued write failed: %v", err)
		}
		if err == nil {
			ran++
		}
	}
	// Writes queued before Close ran rather than being refused.
	if ran == 0 {
		t.Fatal("no queued write ran")
	}
	if err := lockWrite(d, "c1", 0); !errors.Is(err, ErrClosed) {
		t.Fatalf("after Close: %v", err)
	}
}

func TestUsageFlushEndsWhileRowsKeepComing(t *testing.T) {
	d, node, _ := open(t, dbtest.Options{})
	w := d.NewUsageWriter(UsageWriterOptions{Interval: time.Hour, MaxBatch: 20})
	stop := make(chan struct{})
	added := make(chan int)
	go func() {
		n := 0
		for {
			select {
			case <-stop:
				added <- n
				return
			default:
				w.Add(UsageEntry{Timestamp: ISOTime(fixedNow), Model: "m"})
				n++
				time.Sleep(100 * time.Microsecond)
			}
		}
	}()
	time.Sleep(50 * time.Millisecond)
	done := make(chan error, 1)
	go func() { done <- w.Flush(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Flush kept chasing new rows")
	}
	close(stop)
	n := <-added
	if err := w.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := dbtest.QueryString(t, node, `SELECT COUNT(*) FROM usageHistory`); got != fmt.Sprint(n) {
		t.Fatalf("rows %s, added %d", got, n)
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
