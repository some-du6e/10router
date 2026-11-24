package db

import (
	"context"
	"database/sql"
	"errors"
	"sync/atomic"
	"time"
)

// Watch intervals (docs/GO_GATEWAY.md, Config sync).
const (
	// PollInterval is how often the watcher reads PRAGMA data_version, which
	// changes when another connection commits and costs no I/O.
	PollInterval = 250 * time.Millisecond
	// SnapshotTTL caps how stale a snapshot gets even with no generation
	// change: Node's own settings cache lives 5 s.
	SnapshotTTL = 5 * time.Second
)

// WatchOptions configure Watch.
type WatchOptions struct {
	PollInterval time.Duration
	TTL          time.Duration
	// OnStatus is called when the guard's answer changes (ready, or a new
	// reason), so the caller logs one line per change.
	OnStatus func(Status)
	// OnReload is called after each snapshot is published.
	OnReload func(*Snapshot)
	// OnError is called when a poll or a reload fails; the last good
	// snapshot stays.
	OnError func(error)
}

type watchStats struct {
	polls, changes, reloads, checks, errors atomic.Int64
}

// WatchStats count the watcher's work.
type WatchStats struct {
	Polls   int64 `json:"polls"`
	Changes int64 `json:"changes"`
	Reloads int64 `json:"reloads"`
	Checks  int64 `json:"checks"`
	Errors  int64 `json:"errors"`
}

// Stats returns the watcher's counters.
func (d *DB) Stats() WatchStats {
	return WatchStats{
		Polls: d.stats.polls.Load(), Changes: d.stats.changes.Load(), Reloads: d.stats.reloads.Load(),
		Checks: d.stats.checks.Load(), Errors: d.stats.errors.Load(),
	}
}

// Status is the schema guard's latest answer (not ready before Watch's
// first check).
func (d *DB) Status() Status {
	if s := d.status.Load(); s != nil {
		return *s
	}
	return Status{Reason: "the database has not been checked yet"}
}

// Snapshot is the latest config snapshot, nil before the first load or
// while the guard says the schema can't be read.
func (d *DB) Snapshot() *Snapshot {
	if d.Status().Ready {
		return d.snapshot.Load()
	}
	return nil
}

// Watch checks the schema and loads the snapshot, then keeps both current
// until ctx ends: every PollInterval it reads PRAGMA data_version on its own
// reader connection; when that changed it reads _meta.configGeneration and
// PRAGMA schema_version, re-runs the guard when the schema changed, and
// reloads the snapshot when the generation moved. Every TTL it reloads
// anyway. It returns after the first check and load; the loop runs in a
// goroutine. Each read is its own short statement, so no read transaction
// stays open across polls.
func (d *DB) Watch(ctx context.Context, o WatchOptions) error {
	d.watchMu.Lock()
	if d.watching {
		d.watchMu.Unlock()
		return errors.New("db: already watching")
	}
	d.watching = true
	d.watchMu.Unlock()

	if o.PollInterval <= 0 {
		o.PollInterval = PollInterval
	}
	if o.TTL <= 0 {
		o.TTL = SnapshotTTL
	}
	conn, err := d.readers.Conn(ctx)
	if err != nil {
		return err
	}
	w := &watcher{d: d, o: o, conn: conn}
	if err := w.poll(ctx, true); err != nil {
		w.fail(err)
	}
	go func() {
		defer conn.Close()
		t := time.NewTicker(o.PollInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := w.poll(ctx, false); err != nil && ctx.Err() == nil {
					w.fail(err)
				}
			}
		}
	}()
	return nil
}

type watcher struct {
	d    *DB
	o    WatchOptions
	conn *sql.Conn

	dataVersion   int64
	schemaVersion int64
	generation    int64
	loadedAt      time.Time
	checkedAt     time.Time
	lastStatus    *Status
}

func (w *watcher) fail(err error) {
	w.d.stats.errors.Add(1)
	if w.o.OnError != nil {
		w.o.OnError(err)
	}
}

func (w *watcher) poll(ctx context.Context, first bool) error {
	d := w.d
	d.stats.polls.Add(1)
	var dv int64
	if err := w.conn.QueryRowContext(ctx, "PRAGMA data_version").Scan(&dv); err != nil {
		return err
	}
	changed := first || dv != w.dataVersion
	w.dataVersion = dv
	// Wall time, not Options.Now (which only stamps what the gateway writes).
	stale := time.Since(w.loadedAt) >= w.o.TTL
	if !changed && !stale {
		return nil
	}
	if changed {
		d.stats.changes.Add(1)
	}

	var sv int64
	if err := w.conn.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&sv); err != nil {
		return err
	}
	var gen sql.NullString
	err := w.conn.QueryRowContext(ctx, `SELECT value FROM _meta WHERE key = 'configGeneration'`).Scan(&gen)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	generation := jsParseInt(gen.String)

	// A refusal is re-checked every TTL too: what it read (the driver Node
	// recorded, a missing table) can change without a schema change here.
	recheck := w.lastStatus != nil && !w.lastStatus.Ready && time.Since(w.checkedAt) >= w.o.TTL
	if first || sv != w.schemaVersion || recheck {
		w.schemaVersion = sv
		d.stats.checks.Add(1)
		st := d.Check(ctx)
		w.checkedAt = time.Now()
		w.publishStatus(st)
	}
	if !d.Status().Ready {
		return nil
	}
	if !first && !stale && generation == w.generation && d.snapshot.Load() != nil {
		return nil
	}
	snap, err := d.loadSnapshot(ctx)
	if err != nil {
		return err
	}
	d.snapshot.Store(snap)
	d.stats.reloads.Add(1)
	w.generation, w.loadedAt = snap.Generation, time.Now()
	if w.o.OnReload != nil {
		w.o.OnReload(snap)
	}
	return nil
}

func (w *watcher) publishStatus(st Status) {
	w.d.status.Store(&st)
	prev := w.lastStatus
	w.lastStatus = &st
	if prev != nil && prev.Ready == st.Ready && prev.Reason == st.Reason {
		return
	}
	if w.o.OnStatus != nil {
		w.o.OnStatus(st)
	}
}
