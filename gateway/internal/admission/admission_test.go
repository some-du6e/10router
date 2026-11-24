package admission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBusyBodyIsNodes(t *testing.T) {
	raw, err := os.ReadFile("testdata/busy.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		RetryAfterSec int64             `json:"retryAfterSec"`
		Status        int               `json:"status"`
		Headers       map[string]string `json:"headers"`
		Body          string            `json:"body"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 3 {
		t.Fatal("too few cases")
	}
	for _, c := range cases {
		if got := string(BusyBody(c.RetryAfterSec)); got != c.Body {
			t.Errorf("BusyBody(%d) = %s, Node %s", c.RetryAfterSec, got, c.Body)
		}
		if c.Status != 503 || c.Headers["retry-after"] == "" {
			t.Errorf("Node's refusal changed shape: %+v", c)
		}
	}
}

func gate(o Options) *Gate {
	if o.Memory == nil {
		o.Memory = func() int64 { return 0 }
	}
	if o.Copies == 0 {
		o.Copies = 1
	}
	return New(o)
}

func TestNothingInFlightAlwaysGoesIn(t *testing.T) {
	g := gate(Options{BudgetBytes: 10, MaxWait: 0})
	tk, r, err := g.Acquire(context.Background(), 1000)
	if err != nil || r != nil || tk == nil {
		t.Fatalf("got %v %v %v", tk, r, err)
	}
	// A second one over the budget is refused at once with no wait.
	_, r, _ = g.Acquire(context.Background(), 1)
	if r == nil || r.Reason != "budget" {
		t.Fatalf("refusal = %+v", r)
	}
	tk.Release()
	tk.Release() // idempotent
	if s := g.Snapshot(); s.Inflight != 0 || s.Held != 0 || s.Pending != 0 {
		t.Fatalf("after release: %+v", s)
	}
}

func TestQueueIsFIFOAndBounded(t *testing.T) {
	g := gate(Options{BudgetBytes: 100, MaxWait: 2 * time.Second})
	first, _, _ := g.Acquire(context.Background(), 80)
	order := make(chan int, 2)
	done := make(chan *Ticket, 2)
	for i := 1; i <= 2; i++ {
		go func(i int) {
			tk, r, err := g.Acquire(context.Background(), 60)
			if err != nil || r != nil {
				t.Errorf("waiter %d: %v %v", i, r, err)
				done <- nil
				return
			}
			order <- i
			done <- tk
		}(i)
		// The queue is first come, first served: wait until this one is in it.
		for g.Snapshot().Waiting < i {
			time.Sleep(time.Millisecond)
		}
	}
	first.Release()
	a := <-done
	if got := <-order; got != 1 {
		t.Fatalf("first admitted waiter = %d", got)
	}
	// The second still waits: 60 + 60 is over the budget.
	time.Sleep(20 * time.Millisecond)
	if g.Snapshot().Waiting != 1 {
		t.Fatalf("snapshot %+v", g.Snapshot())
	}
	a.Release()
	b := <-done
	b.Release()
	if got := <-order; got != 2 {
		t.Fatalf("second = %d", got)
	}
}

func TestRefusesAfterMaxWait(t *testing.T) {
	g := gate(Options{BudgetBytes: 100, MaxWait: 30 * time.Millisecond, RetryAfterSec: 7})
	tk, _, _ := g.Acquire(context.Background(), 90)
	defer tk.Release()
	start := time.Now()
	_, r, err := g.Acquire(context.Background(), 20)
	if err != nil || r == nil || r.Reason != "budget" || r.RetryAfterSec != 7 {
		t.Fatalf("got %+v %v", r, err)
	}
	if time.Since(start) < 30*time.Millisecond {
		t.Fatal("refused before the wait ran out")
	}
	if s := g.Snapshot(); s.Waiting != 0 || s.Refused != 1 || s.Queued != 1 {
		t.Fatalf("snapshot %+v", s)
	}
}

func TestAbortWhileWaiting(t *testing.T) {
	g := gate(Options{BudgetBytes: 100, MaxWait: time.Minute})
	tk, _, _ := g.Acquire(context.Background(), 90)
	defer tk.Release()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for g.Snapshot().Waiting == 0 {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	_, r, err := g.Acquire(ctx, 20)
	if !errors.Is(err, context.Canceled) || r != nil {
		t.Fatalf("got %v %v", r, err)
	}
	if s := g.Snapshot(); s.Waiting != 0 || s.Aborted != 1 || s.Inflight != 1 {
		t.Fatalf("snapshot %+v", s)
	}
}

func TestUnknownLengthCountsUntilRead(t *testing.T) {
	g := gate(Options{BudgetBytes: 10 * mib, UnknownBody: 4 * mib})
	a, _, _ := g.Acquire(context.Background(), -1)
	b, _, _ := g.Acquire(context.Background(), -1)
	if s := g.Snapshot(); s.Held != 8*mib || s.Pending != 8*mib {
		t.Fatalf("two chunked bodies count 4MB each: %+v", s)
	}
	// A third doesn't fit until one turns out small.
	_, r, _ := g.Acquire(context.Background(), -1)
	if r == nil {
		t.Fatal("a third 4MB guess fit a 10MB budget")
	}
	a.NoteBodyLength(1000)
	if s := g.Snapshot(); s.Held != 4*mib+1000 {
		t.Fatalf("the real length replaces the guess: %+v", s)
	}
	// A stated length only grows.
	c, _, _ := g.Acquire(context.Background(), 2000)
	c.NoteBodyLength(10)
	c.NoteBodyLength(3000)
	if s := g.Snapshot(); s.Held != 4*mib+1000+3000 {
		t.Fatalf("held %d", s.Held)
	}
	b.Replied()
	if s := g.Snapshot(); s.Pending != 1000+3000 {
		t.Fatalf("a replying request isn't pending: %+v", s)
	}
	for _, tk := range []*Ticket{a, b, c} {
		tk.Release()
	}
	if s := g.Snapshot(); s.Held != 0 || s.Pending != 0 || s.Inflight != 0 {
		t.Fatalf("after release: %+v", s)
	}
}

func TestMemoryHighWaterWaitsForMemoryToDrop(t *testing.T) {
	var mem atomic.Int64
	// 950 + (10 pending + 10 new) × 3 copies is over 1000.
	mem.Store(950)
	g := gate(Options{HighWaterBytes: 1000, PendingCopies: 3, MaxWait: time.Second, Recheck: 5 * time.Millisecond, Memory: mem.Load})
	tk, _, _ := g.Acquire(context.Background(), 10)
	defer tk.Release()
	got := make(chan *Ticket)
	go func() {
		t2, _, _ := g.Acquire(context.Background(), 10)
		got <- t2
	}()
	time.Sleep(30 * time.Millisecond)
	select {
	case <-got:
		t.Fatal("admitted over the high water")
	default:
	}
	// A collection brings memory down; the recheck lets the waiter in.
	mem.Store(100)
	select {
	case t2 := <-got:
		t2.Release()
	case <-time.After(time.Second):
		t.Fatal("the recheck never admitted the waiter")
	}
}

func TestFitBudget(t *testing.T) {
	var g int64 = 2048 * mib
	if b, why := FitBudget(256*mib, 900*mib, g); b != 256*mib || why != "" {
		t.Fatalf("a 2 GiB container fits 256+900: %d %q", b, why)
	}
	b, why := FitBudget(1024*mib, 900*mib, g)
	if b != int64(float64(g)*0.8)-900*mib || !strings.Contains(why, "INFLIGHT_BODY_BUDGET_MB") {
		t.Fatalf("got %d %q", b, why)
	}
	if b, _ := FitBudget(256*mib, 1900*mib, g); b != MinBudgetMB*mib {
		t.Fatalf("floor: %d", b)
	}
	if b, why := FitBudget(256*mib, 900*mib, 0); b != 256*mib || why != "" {
		t.Fatal("no container limit: unchanged")
	}
}

func TestFromEnvReadsNodesVariablesLikeNode(t *testing.T) {
	env := map[string]string{
		"INFLIGHT_QUEUE_WAIT_MS":          " 2500 ",
		"INFLIGHT_RETRY_AFTER_S":          "0", // under min: default
		"INFLIGHT_UNKNOWN_BODY_MB":        "1e3",
		"GATEWAY_INFLIGHT_BODY_BUDGET_MB": "64",
	}
	o := FromEnv(func(k string) string { return env[k] }, 1000*mib)
	if o.MaxWait != 2500*time.Millisecond || o.RetryAfterSec != 10 || o.UnknownBody != 4*mib || o.BudgetBytes != 64*mib {
		t.Fatalf("%+v", o)
	}
	if o.HighWaterBytes != 800*mib {
		t.Fatalf("high water %d", o.HighWaterBytes)
	}
	if o := FromEnv(func(string) string { return "" }, 0); o.HighWaterBytes != 0 || o.BudgetBytes != DefaultBudgetMB*mib {
		t.Fatalf("defaults %+v", o)
	}
	if n := NodeBudgetBytes(func(string) string { return "" }); n != 900*mib {
		t.Fatalf("Node's default budget %d", n)
	}
}
