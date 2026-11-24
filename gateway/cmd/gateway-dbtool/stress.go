package main

import (
	"context"
	"flag"
	"fmt"
	"math/rand/v2"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// latencies collects one kind of operation's durations.
type latencies struct {
	mu sync.Mutex
	d  []time.Duration
}

func (l *latencies) add(d time.Duration) {
	l.mu.Lock()
	l.d = append(l.d, d)
	l.mu.Unlock()
}

type summary struct {
	Count int     `json:"count"`
	P50Ms float64 `json:"p50Ms"`
	P99Ms float64 `json:"p99Ms"`
	MaxMs float64 `json:"maxMs"`
}

func (l *latencies) summary() summary {
	l.mu.Lock()
	d := append([]time.Duration(nil), l.d...)
	l.mu.Unlock()
	if len(d) == 0 {
		return summary{}
	}
	slices.Sort(d)
	ms := func(x time.Duration) float64 { return float64(x.Microseconds()) / 1000 }
	at := func(p float64) time.Duration { return d[min(len(d)-1, int(p*float64(len(d))))] }
	return summary{Count: len(d), P50Ms: ms(at(0.5)), P99Ms: ms(at(0.99)), MaxMs: ms(d[len(d)-1])}
}

type errorCounts struct {
	total, busy atomic.Int64
	mu          sync.Mutex
	first       []string
}

func (e *errorCounts) add(err error) {
	if err == nil {
		return
	}
	e.total.Add(1)
	if db.IsBusy(err) {
		e.busy.Add(1)
	}
	e.mu.Lock()
	if len(e.first) < 10 {
		e.first = append(e.first, err.Error())
	}
	e.mu.Unlock()
}

// every runs fn every interval until ctx ends.
func every(ctx context.Context, wg *sync.WaitGroup, interval time.Duration, fn func()) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				fn()
			}
		}
	}()
}

// runStress is the gateway's side of the stress job: the writes and reads
// phase 2 makes, at rates above a busy install's, while Node does its own.
func runStress(args []string) error {
	fs := flag.NewFlagSet("stress", flag.ExitOnError)
	path := fs.String("db", "", "database file")
	duration := fs.Duration("duration", 30*time.Second, "how long to run")
	provider := fs.String("provider", "stress", "provider whose connections are patched and listed")
	usageRate := fs.Int("usage-rate", 500, "usage rows per second (written in 100 ms batches)")
	patchRate := fs.Int("patch-rate", 100, "connection lock writes per second")
	detailRate := fs.Int("detail-rate", 50, "request-detail rows per second (written every 200 ms)")
	readers := fs.Int("readers", 4, "goroutines listing connections and looking up keys")
	_ = fs.Parse(args)

	d, err := db.Open(*path, db.Options{})
	if err != nil {
		return err
	}
	defer d.Close()
	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	var errs errorCounts
	var generations sync.Map
	if err := d.Watch(ctx, db.WatchOptions{
		OnReload: func(s *db.Snapshot) { generations.Store(s.Generation, true) },
		OnError:  errs.add,
	}); err != nil {
		return err
	}
	if st := d.Status(); !st.Ready {
		return fmt.Errorf("the schema guard refused the file: %s", st.Reason)
	}
	firstGen := d.Snapshot().Generation
	keys := []string{}
	for k := range d.Snapshot().APIKeys {
		keys = append(keys, k)
	}
	active := true
	conns, err := d.ListConnections(ctx, *provider, &active)
	if err != nil {
		return err
	}
	if len(conns) == 0 || len(keys) == 0 {
		return fmt.Errorf("seed the file first: %d connections of %q, %d keys", len(conns), *provider, len(keys))
	}

	var (
		wg                         sync.WaitGroup
		usageLat, patchLat, detLat latencies
		readLat                    latencies
		reads, patches, details    atomic.Int64
	)
	// Flushed every 100 ms below, so each flush is timed.
	usage := d.NewUsageWriter(db.UsageWriterOptions{Interval: time.Hour, OnError: errs.add})
	perTick := max(1, *usageRate/100)
	every(ctx, &wg, 10*time.Millisecond, func() {
		for i := 0; i < perTick; i++ {
			c := conns[rand.IntN(len(conns))]
			tokens := jsjson.NewObject()
			tokens.Set("input_tokens", float64(1000+rand.IntN(5000)))
			tokens.Set("output_tokens", float64(rand.IntN(800)))
			tokens.Set("cache_read_input_tokens", float64(rand.IntN(4000)))
			usage.Add(db.UsageEntry{
				Timestamp: db.ISOTime(time.Now()), Provider: *provider, Model: "gw-model",
				ConnectionID: c.ID, APIKey: keys[rand.IntN(len(keys))], Endpoint: "/v1/messages",
				Tokens: tokens, Cost: rand.Float64() / 100,
			})
		}
	})

	if *patchRate > 0 {
		every(ctx, &wg, time.Second/time.Duration(*patchRate), func() {
			c := conns[rand.IntN(len(conns))]
			var set []jsjson.Member
			if rand.IntN(2) == 0 {
				set = []jsjson.Member{
					{Key: "modelLock_gw-model", Value: db.ISOTime(time.Now().Add(30 * time.Second))},
					{Key: "modelLimit_gw-model", Value: true}, {Key: "testStatus", Value: "unavailable"},
					{Key: "lastError", Value: "rate limited"}, {Key: "errorCode", Value: 429.0},
					{Key: "lastErrorAt", Value: db.ISOTime(time.Now())}, {Key: "backoffLevel", Value: 1.0},
				}
			} else {
				set = []jsjson.Member{
					{Key: "modelLock_gw-model", Value: nil}, {Key: "modelLimit_gw-model", Value: nil},
					{Key: "testStatus", Value: "active"}, {Key: "lastError", Value: nil}, {Key: "errorCode", Value: nil},
					{Key: "backoffLevel", Value: 0.0}, {Key: "lastUsedAt", Value: db.ISOTime(time.Now())},
				}
			}
			start := time.Now()
			_, err := d.UpdateConnection(context.Background(), c.ID, db.ConnectionUpdate{Set: set})
			patchLat.add(time.Since(start))
			patches.Add(1)
			errs.add(err)
		})
	}

	if *detailRate > 0 {
		perFlush := max(1, *detailRate/5)
		seq := 0
		every(ctx, &wg, 200*time.Millisecond, func() {
			rows := make([]db.RequestDetail, perFlush)
			for i := range rows {
				seq++
				ts := db.ISOTime(time.Now())
				req := jsjson.NewObject()
				req.Set("model", "gw-model")
				req.Set("messages", []any{"synthetic"})
				rows[i] = db.RequestDetail{ID: fmt.Sprintf("%s-gw%06d-gw-model", ts, seq), Timestamp: ts, Provider: *provider,
					Model: "gw-model", ConnectionID: conns[rand.IntN(len(conns))].ID, Status: "success", Request: req}
			}
			start := time.Now()
			err := d.SaveRequestDetails(context.Background(), rows, 500)
			detLat.add(time.Since(start))
			details.Add(int64(len(rows)))
			errs.add(err)
		})
	}

	for i := 0; i < *readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				start := time.Now()
				_, err := d.ListConnections(ctx, *provider, &active)
				if err == nil {
					_, err = d.APIKeyByKey(ctx, keys[rand.IntN(len(keys))])
				}
				readLat.add(time.Since(start))
				if ctx.Err() == nil {
					errs.add(err)
				}
				reads.Add(1)
				time.Sleep(time.Millisecond)
			}
		}()
	}

	// Usage batches: time each flush the writer makes.
	every(ctx, &wg, 100*time.Millisecond, func() {
		start := time.Now()
		err := usage.Flush(context.Background())
		usageLat.add(time.Since(start))
		errs.add(err)
	})

	<-ctx.Done()
	wg.Wait()
	errs.add(usage.Close(context.Background()))
	written, dropped, _ := usage.Stats()

	var seen []int64
	generations.Range(func(k, _ any) bool { seen = append(seen, k.(int64)); return true })
	slices.Sort(seen)
	stats := d.Stats()
	out := map[string]any{
		"ok":               errs.total.Load() == 0 && dropped == 0,
		"errors":           errs.total.Load(),
		"busyErrors":       errs.busy.Load(),
		"firstErrors":      errs.first,
		"usageRows":        written,
		"usageDropped":     dropped,
		"connectionWrites": patches.Load(),
		"detailRows":       details.Load(),
		"reads":            reads.Load(),
		"watch":            stats,
		"firstGeneration":  firstGen,
		"generations":      seen,
		"latency": map[string]summary{
			"usageBatch":      usageLat.summary(),
			"connectionWrite": patchLat.summary(),
			"detailBatch":     detLat.summary(),
			"read":            readLat.summary(),
		},
		"status": d.Status(),
	}
	printJSON(out)
	if errs.total.Load() > 0 || dropped > 0 {
		return exitError(1)
	}
	return nil
}

// runBench times the hot-path queries on a seeded file, for comparison with
// the same queries through better-sqlite3 (tests/bench/gateway-db-benchmark.test.js).
func runBench(args []string) error {
	fs := flag.NewFlagSet("bench", flag.ExitOnError)
	path := fs.String("db", "", "database file")
	provider := fs.String("provider", "bench", "provider whose connections are listed")
	iters := fs.Int("iters", 2000, "iterations of each read")
	batch := fs.Int("batch", 50, "usage rows per transaction")
	_ = fs.Parse(args)
	d, err := db.Open(*path, db.Options{})
	if err != nil {
		return err
	}
	defer d.Close()
	ctx := context.Background()
	keys, err := d.APIKeys(ctx)
	if err != nil || len(keys) == 0 {
		return fmt.Errorf("seed the file first (keys: %d, %v)", len(keys), err)
	}
	active := true
	conns, err := d.ListConnections(ctx, *provider, &active)
	if err != nil || len(conns) == 0 {
		return fmt.Errorf("seed the file first (connections: %d, %v)", len(conns), err)
	}

	time1 := func(n int, fn func(i int) error) (float64, error) {
		// Warm up the statement cache and the pages.
		for i := 0; i < min(n, 50); i++ {
			if err := fn(i); err != nil {
				return 0, err
			}
		}
		start := time.Now()
		for i := 0; i < n; i++ {
			if err := fn(i); err != nil {
				return 0, err
			}
		}
		return float64(time.Since(start).Nanoseconds()) / float64(n) / 1000, nil
	}
	listUs, err := time1(*iters, func(int) error { _, err := d.ListConnections(ctx, *provider, &active); return err })
	if err != nil {
		return err
	}
	keyUs, err := time1(*iters*5, func(i int) error { _, err := d.APIKeyByKey(ctx, keys[i%len(keys)].Key); return err })
	if err != nil {
		return err
	}
	entry := func(i int) db.UsageEntry {
		tokens := jsjson.NewObject()
		tokens.Set("input_tokens", 1200.0)
		tokens.Set("output_tokens", 300.0)
		return db.UsageEntry{Timestamp: db.ISOTime(time.Now()), Provider: *provider, Model: "bench-model",
			ConnectionID: conns[i%len(conns)].ID, APIKey: keys[i%len(keys)].Key, Endpoint: "/v1/messages", Tokens: tokens, Cost: 0.001}
	}
	usageUs := func(size int) (float64, error) {
		rounds := max(20, *iters/size)
		perBatch, err := time1(rounds, func(r int) error {
			entries := make([]db.UsageEntry, size)
			for i := range entries {
				entries[i] = entry(r*size + i)
			}
			return d.WriteUsage(ctx, entries)
		})
		return perBatch / float64(size), err
	}
	oneUs, err := usageUs(1)
	if err != nil {
		return err
	}
	batchUs, err := usageUs(*batch)
	if err != nil {
		return err
	}
	printJSON(map[string]any{
		"driver":          "modernc.org/sqlite",
		"connections":     len(conns),
		"keys":            len(keys),
		"listConnections": map[string]float64{"usPerOp": listUs},
		"keyLookup":       map[string]float64{"usPerOp": keyUs},
		"usageRow":        map[string]float64{"usPerRowAlone": oneUs, "usPerRowBatched": batchUs, "batch": float64(*batch)},
	})
	return nil
}
