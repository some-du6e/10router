package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

// Write pacing. SQLite has no queue for its write lock: a process waiting
// for it polls, sleeping 1 to 100 ms between tries, and the lock goes to
// whoever asks while it is free. A gateway that started its next write the
// moment the last one committed would win every time, and Node, whose
// better-sqlite3 or node:sqlite waits on its event loop, would starve until
// its 5 s busy_timeout ran out (the stress job showed exactly that). So the
// gateway's writes go through one goroutine, which puts every write queued
// at that moment into one transaction, stops taking more once it has held
// the lock for MaxWriteHold, and then leaves the lock free for at least
// WriteGap before it begins again.
const (
	// WriteGap is the least time between two of the gateway's write
	// transactions: Node's window to take the lock.
	WriteGap = 25 * time.Millisecond
	// MaxWriteHold is how long one transaction keeps taking queued writes.
	// One write runs to its end, however long it takes.
	MaxWriteHold = 10 * time.Millisecond
	// writeQueue is how many writes may wait.
	writeQueue = 4096
	// batchTimeout bounds one transaction, busy waits included.
	batchTimeout = 30 * time.Second
)

// ErrClosed is returned for a write after Close.
var ErrClosed = errors.New("db: closed")

type writeOp struct {
	fn   func(ctx context.Context, tx *sql.Tx) error
	done chan error
}

type writer struct {
	db       *sql.DB
	gap      time.Duration
	maxHold  time.Duration
	ops      chan *writeOp
	mu       sync.RWMutex
	closed   bool
	stop     chan struct{}
	finished chan struct{}

	statsMu sync.Mutex
	stats   writeStats
}

type writeStats struct {
	transactions, writes, failed int64
	holds, waits                 []time.Duration // the last statsWindow of each
}

const statsWindow = 4096

func newWriter(db *sql.DB) *writer {
	w := &writer{db: db, gap: WriteGap, maxHold: MaxWriteHold, ops: make(chan *writeOp, writeQueue),
		stop: make(chan struct{}), finished: make(chan struct{})}
	go w.loop()
	return w
}

func (w *writer) submit(ctx context.Context, fn func(ctx context.Context, tx *sql.Tx) error) error {
	op := &writeOp{fn: fn, done: make(chan error, 1)}
	w.mu.RLock()
	if w.closed {
		w.mu.RUnlock()
		return ErrClosed
	}
	select {
	case w.ops <- op:
	case <-ctx.Done():
		w.mu.RUnlock()
		return ctx.Err()
	}
	w.mu.RUnlock()
	return <-op.done
}

// close stops taking writes, runs the ones queued, and returns when done.
func (w *writer) close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		<-w.finished
		return
	}
	w.closed = true
	w.mu.Unlock()
	close(w.stop)
	<-w.finished
}

func (w *writer) loop() {
	defer close(w.finished)
	var lastEnd time.Time
	for {
		var first *writeOp
		select {
		case first = <-w.ops:
		case <-w.stop:
			// No submit can start now; run what is queued.
			for {
				select {
				case op := <-w.ops:
					w.batch(op)
				default:
					return
				}
			}
		}
		if wait := w.gap - time.Since(lastEnd); wait > 0 && !lastEnd.IsZero() {
			time.Sleep(wait)
		}
		w.batch(first)
		lastEnd = time.Now()
	}
}

// batch runs first, then whatever else is queued, in one transaction.
func (w *writer) batch(first *writeOp) {
	ctx, cancel := context.WithTimeout(context.Background(), batchTimeout)
	defer cancel()
	asked := time.Now()
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		w.record(time.Since(asked), 0, 1, 1)
		first.done <- err
		return
	}
	began := time.Now()
	ops := []*writeOp{first}
	errs := []error{runOp(ctx, tx, first)}
	for time.Since(began) < w.maxHold {
		select {
		case op := <-w.ops:
			ops = append(ops, op)
			errs = append(errs, runOp(ctx, tx, op))
			continue
		default:
		}
		break
	}
	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
		for i := range errs {
			errs[i] = err
		}
	}
	failed := 0
	for i, op := range ops {
		if errs[i] != nil {
			failed++
		}
		op.done <- errs[i]
	}
	w.record(began.Sub(asked), time.Since(began), len(ops), failed)
}

// runOp runs one write in a savepoint, so its error (or panic) undoes it alone.
func runOp(ctx context.Context, tx *sql.Tx, op *writeOp) (err error) {
	if _, err := tx.ExecContext(ctx, "SAVEPOINT gw_write"); err != nil {
		return err
	}
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("db: write panicked: %v", r)
		}
		if err != nil {
			_, _ = tx.ExecContext(ctx, "ROLLBACK TO gw_write")
		}
		if _, relErr := tx.ExecContext(ctx, "RELEASE gw_write"); relErr != nil && err == nil {
			err = relErr
		}
	}()
	return op.fn(ctx, tx)
}

func (w *writer) record(wait, hold time.Duration, writes, failed int) {
	w.statsMu.Lock()
	defer w.statsMu.Unlock()
	s := &w.stats
	s.transactions++
	s.writes += int64(writes)
	s.failed += int64(failed)
	s.waits = appendWindow(s.waits, wait)
	s.holds = appendWindow(s.holds, hold)
}

func appendWindow(d []time.Duration, v time.Duration) []time.Duration {
	if len(d) >= statsWindow {
		d = d[1:]
	}
	return append(d, v)
}

// LockStats describe the writer's transactions: how long each held the write
// lock (BEGIN IMMEDIATE to COMMIT) and how long it waited for it.
type LockStats struct {
	Transactions int64   `json:"transactions"`
	Writes       int64   `json:"writes"`
	Failed       int64   `json:"failed"`
	HoldP50Ms    float64 `json:"holdP50Ms"`
	HoldP99Ms    float64 `json:"holdP99Ms"`
	HoldMaxMs    float64 `json:"holdMaxMs"`
	WaitP99Ms    float64 `json:"waitP99Ms"`
	WaitMaxMs    float64 `json:"waitMaxMs"`
}

// LockStats are the writer's figures over its last few thousand transactions.
func (d *DB) LockStats() LockStats {
	w := d.w
	w.statsMu.Lock()
	s := w.stats
	holds, waits := slices.Clone(s.holds), slices.Clone(s.waits)
	w.statsMu.Unlock()
	ms := func(x time.Duration) float64 { return float64(x.Microseconds()) / 1000 }
	pct := func(d []time.Duration, p float64) float64 {
		if len(d) == 0 {
			return 0
		}
		slices.Sort(d)
		return ms(d[min(len(d)-1, int(p*float64(len(d))))])
	}
	return LockStats{
		Transactions: s.transactions, Writes: s.writes, Failed: s.failed,
		HoldP50Ms: pct(holds, 0.5), HoldP99Ms: pct(holds, 0.99), HoldMaxMs: pct(holds, 1),
		WaitP99Ms: pct(waits, 0.99), WaitMaxMs: pct(waits, 1),
	}
}
