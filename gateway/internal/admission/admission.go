// Package admission is the gateway's own memory gate for native requests
// (docs/GO_GATEWAY.md, phase 2; Node's is src/sse/services/memoryAdmission.js).
//
// A native request holds its body until its reply starts: the bytes read off
// the wire, and the upstream body claudeprep builds from them (reused across
// account fallbacks). The gate counts each admitted body once (Copies, 1 by
// default, where Node counts three: its text, parsed and translated copies)
// and lets a new request in only while the bodies fit Budget and the
// container's memory stays under its high water. Otherwise the request waits
// its turn (FIFO) for up to MaxWait, then gets Node's own 503
// overloaded_error with Retry-After, which the Anthropic SDK retries. With
// nothing in flight a request always goes in, however big, so one huge
// prompt is never starved. A body without Content-Length counts as
// UnknownBody until it has been read, not as 0, so a burst of chunked
// requests can't all go in at once.
//
// Node and the gateway share one container. Node's gate watches its own
// resident memory; this one watches the container's anonymous memory (both
// processes), so when Node is near the limit the gateway stops adding to it.
// FitBudget makes the two budgets add up under the container's memory.max.
package admission

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const mib = 1 << 20

// maxLength caps a body length the gate counts. A client's Content-Length
// can be anything up to 2^63-1, and Node counts in doubles, where a huge one
// just never fits; counted as is here, times the copies, it would wrap the
// int64 sums negative and let everything in. Any body this long is over any
// budget anyway.
const maxLength = 1 << 40

// maxMB caps a megabyte setting so it can't wrap once in bytes.
const maxMB = 1 << 23

//go:embed tables.json
var tablesJSON []byte

// nodeDefaults is Node's MEMORY_ADMISSION, exported by
// tests/unit/gateway-admission-parity.test.js. The gateway reads the same
// environment variables Node does for the settings they share, with Node's
// defaults, so both processes queue and refuse alike.
var nodeDefaults struct {
	BudgetMB          int64   `json:"budgetMb"`
	BodyCopies        int64   `json:"bodyCopies"`
	MaxWaitMs         int64   `json:"maxWaitMs"`
	RetryAfterSec     int64   `json:"retryAfterSec"`
	UnknownBodyMB     int64   `json:"unknownBodyMb"`
	RecheckMs         int64   `json:"recheckMs"`
	HighWaterFraction float64 `json:"highWaterFraction"`
	MaxTimerMs        int64   `json:"maxTimerMs"`
	BusyMessage       string  `json:"busyMessage"`
	BusyErrorType     string  `json:"busyErrorType"`
}

func init() {
	if err := json.Unmarshal(tablesJSON, &nodeDefaults); err != nil {
		panic(fmt.Sprintf("admission: tables.json: %v", err))
	}
	if nodeDefaults.BodyCopies <= 0 || nodeDefaults.RecheckMs <= 0 || !strings.Contains(nodeDefaults.BusyMessage, "{s}") {
		panic("admission: tables.json is incomplete")
	}
}

// Defaults for the gateway's own settings.
const (
	// DefaultBudgetMB is GATEWAY_INFLIGHT_BODY_BUDGET_MB's default: bodies
	// times Copies the gateway's admitted requests may hold.
	DefaultBudgetMB = 256
	// DefaultCopies is GATEWAY_BODY_COPIES's default.
	DefaultCopies = 1
	// DefaultPendingCopies weighs a body not yet replying against the high
	// water: the bytes read, the parsed tree claudeprep edits, and the bytes
	// it builds are all alive while a request is prepared.
	DefaultPendingCopies = 3
	// MinBudgetMB is as far as FitBudget shrinks the budget.
	MinBudgetMB = 32
)

// Options configure a gate.
type Options struct {
	// BudgetBytes caps held bytes (bodies × Copies); 0 is no budget.
	BudgetBytes int64
	Copies      int64
	// HighWaterBytes caps the container's anonymous memory plus PendingCopies
	// × the bodies not yet replying; 0 is no check.
	HighWaterBytes int64
	PendingCopies  int64
	// UnknownBody is what a body without Content-Length counts as until read.
	UnknownBody   int64
	MaxWait       time.Duration
	RetryAfterSec int64
	Recheck       time.Duration
	// Memory reads the container's anonymous memory in bytes (ContainerAnon
	// when nil).
	Memory func() int64
	// Logf logs a refusal episode's start and end (nil: no log).
	Logf func(format string, args ...any)
}

// envInt is runtimeConfig.js's envInt: a plain non-negative decimal integer
// within [min, max], else the default.
func envInt(getenv func(string) string, name string, def, min, max int64) int64 {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" || !digits.MatchString(raw) {
		return def
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	// Number.isSafeInteger: up to 2^53-1.
	if err != nil || n > 1<<53-1 || n < min || n > max {
		return def
	}
	return n
}

var digits = regexp.MustCompile(`^[0-9]+$`)

// FromEnv reads the gate's settings. The queue wait, Retry-After and the
// unknown-body size are Node's variables (INFLIGHT_QUEUE_WAIT_MS,
// INFLIGHT_RETRY_AFTER_S, INFLIGHT_UNKNOWN_BODY_MB) with Node's defaults; the
// budget, copies and high water are the gateway's own
// (GATEWAY_INFLIGHT_BODY_BUDGET_MB, GATEWAY_BODY_COPIES,
// GATEWAY_MEMORY_HIGH_WATER_MB: unset is Node's fraction of memory.max).
// containerLimit is memory.max in bytes, 0 when there is none.
func FromEnv(getenv func(string) string, containerLimit int64) Options {
	o := Options{
		BudgetBytes:   envMB(getenv, "GATEWAY_INFLIGHT_BODY_BUDGET_MB", DefaultBudgetMB),
		Copies:        envInt(getenv, "GATEWAY_BODY_COPIES", DefaultCopies, 1, 16),
		PendingCopies: DefaultPendingCopies,
		UnknownBody:   envMB(getenv, "INFLIGHT_UNKNOWN_BODY_MB", nodeDefaults.UnknownBodyMB),
		MaxWait:       time.Duration(envInt(getenv, "INFLIGHT_QUEUE_WAIT_MS", nodeDefaults.MaxWaitMs, 0, nodeDefaults.MaxTimerMs)) * time.Millisecond,
		RetryAfterSec: envInt(getenv, "INFLIGHT_RETRY_AFTER_S", nodeDefaults.RetryAfterSec, 1, 3600),
		Recheck:       time.Duration(nodeDefaults.RecheckMs) * time.Millisecond,
	}
	switch hw := envMB(getenv, "GATEWAY_MEMORY_HIGH_WATER_MB", -1); {
	case hw >= 0:
		o.HighWaterBytes = hw
	case containerLimit > 0:
		o.HighWaterBytes = int64(float64(containerLimit) * nodeDefaults.HighWaterFraction)
	}
	return o
}

// envMB is envInt for a megabyte setting, in bytes (a negative default
// stays negative). A value past maxMB counts as maxMB, so it can't wrap.
func envMB(getenv func(string) string, name string, def int64) int64 {
	n := envInt(getenv, name, def, 0, 1<<53-1)
	if n < 0 {
		return n
	}
	return min(n, maxMB) * mib
}

// NodeBudgetBytes is Node's own budget (INFLIGHT_BODY_BUDGET_MB, its bodies
// times its three copies), read the way Node reads it.
func NodeBudgetBytes(getenv func(string) string) int64 {
	return envMB(getenv, "INFLIGHT_BODY_BUDGET_MB", nodeDefaults.BudgetMB)
}

// FitBudget shrinks the gateway's budget so that it and Node's add up under
// the container's high water (Node's fraction of memory.max), never below
// MinBudgetMB. It returns the budget and, when it changed, why. Without a
// container limit, or with either budget off, the budget stands.
func FitBudget(goBudget, nodeBudget, containerLimit int64) (int64, string) {
	if containerLimit <= 0 || goBudget <= 0 || nodeBudget <= 0 {
		return goBudget, ""
	}
	room := int64(float64(containerLimit)*nodeDefaults.HighWaterFraction) - nodeBudget
	if goBudget <= room {
		return goBudget, ""
	}
	// Never above what was set: the floor only stops a shrink going too far.
	fit := min(goBudget, max(room, MinBudgetMB*mib))
	if fit == goBudget {
		return goBudget, ""
	}
	return fit, fmt.Sprintf("the gateway's body budget (%dMB) and Node's (%dMB) don't fit under %.0f%% of the container's memory (%dMB); using %dMB for the gateway. Lower INFLIGHT_BODY_BUDGET_MB or GATEWAY_INFLIGHT_BODY_BUDGET_MB to choose the split",
		goBudget/mib, nodeBudget/mib, nodeDefaults.HighWaterFraction*100, containerLimit/mib, fit/mib)
}

// Refusal is a request the gate turned away.
type Refusal struct {
	Reason        string // "budget", "memory" or "queue"
	RetryAfterSec int64
}

// Gate counts the admitted requests' bodies.
type Gate struct {
	o Options

	mu       sync.Mutex
	held     int64 // bytes × Copies of every admitted request
	pending  int64 // bytes of admitted requests not yet replying
	inflight int
	queue    []*waiter
	recheck  *time.Ticker
	stop     chan struct{}

	// The last memory reading and when it was taken (memory()).
	memAt  time.Time
	memVal int64

	refusingSince time.Time
	refused       int
	stats         Stats
}

// Stats are the gate's counters.
type Stats struct {
	Admitted, Queued, Refused, Aborted int64
}

type waiter struct {
	length int64
	sized  bool
	ready  chan *Ticket
}

// New makes a gate.
func New(o Options) *Gate {
	if o.Copies <= 0 {
		o.Copies = DefaultCopies
	}
	if o.PendingCopies <= 0 {
		o.PendingCopies = DefaultPendingCopies
	}
	if o.Recheck <= 0 {
		o.Recheck = time.Duration(nodeDefaults.RecheckMs) * time.Millisecond
	}
	if o.RetryAfterSec <= 0 {
		o.RetryAfterSec = nodeDefaults.RetryAfterSec
	}
	if o.Memory == nil {
		o.Memory = ContainerAnon
	}
	return &Gate{o: o}
}

// Enabled: the gate checks anything at all.
func (g *Gate) Enabled() bool { return g.o.BudgetBytes > 0 || g.o.HighWaterBytes > 0 }

// memoryCacheFor is how long one memory reading stands. Reading memory.stat
// is a file read, and blocker runs on every request while any is in flight
// and once per waiter in pump; the recheck that waits for memory to drop
// runs far less often than this goes stale.
const memoryCacheFor = 10 * time.Millisecond

// memory is the container's memory, read at most once per memoryCacheFor.
// Callers hold mu.
func (g *Gate) memory() int64 {
	if now := time.Now(); g.memAt.IsZero() || now.Sub(g.memAt) >= memoryCacheFor {
		g.memVal, g.memAt = g.o.Memory(), now
	}
	return g.memVal
}

// blocker is why a body of length can't go in now, or "". Callers hold mu.
func (g *Gate) blocker(length int64) string {
	if g.inflight == 0 {
		return ""
	}
	if g.o.BudgetBytes > 0 && g.held+length*g.o.Copies > g.o.BudgetBytes {
		return "budget"
	}
	if g.o.HighWaterBytes > 0 && g.memory()+(g.pending+length)*g.o.PendingCopies > g.o.HighWaterBytes {
		return "memory"
	}
	return ""
}

// Acquire waits for room for a body of bodyLength bytes (-1: no
// Content-Length). It returns a ticket, or a refusal, or ctx's error when
// the client left while waiting.
func (g *Gate) Acquire(ctx context.Context, bodyLength int64) (*Ticket, *Refusal, error) {
	sized := bodyLength >= 0
	length := bodyLength
	if !sized {
		length = g.o.UnknownBody
	}
	length = min(length, maxLength)
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	g.mu.Lock()
	if len(g.queue) == 0 && g.blocker(length) == "" {
		t := g.grant(length, sized)
		g.mu.Unlock()
		return t, nil, nil
	}
	if g.o.MaxWait <= 0 {
		why := g.blocker(length)
		if why == "" {
			why = "queue"
		}
		r := g.refuse(why, length)
		g.mu.Unlock()
		return nil, r, nil
	}
	g.stats.Queued++
	w := &waiter{length: length, sized: sized, ready: make(chan *Ticket, 1)}
	g.queue = append(g.queue, w)
	g.startRecheck()
	g.mu.Unlock()

	timer := time.NewTimer(g.o.MaxWait)
	defer timer.Stop()
	select {
	case t := <-w.ready:
		return t, nil, nil
	case <-ctx.Done():
		g.mu.Lock()
		g.stats.Aborted++
		if g.remove(w) {
			// Leaving from the front may let the next one in.
			g.pump()
			g.mu.Unlock()
			return nil, nil, ctx.Err()
		}
		g.mu.Unlock()
		// Admitted just as the client left: hand the room back.
		t := <-w.ready
		t.Release()
		return nil, nil, ctx.Err()
	case <-timer.C:
		g.mu.Lock()
		// Queue order first: room that appeared since the last pump goes to
		// the waiters from the front, this one included if it is there. Go
		// may wake waiters whose deadlines nearly coincide in either order,
		// where Node's timers fire in the order they were set.
		g.pump()
		if !g.remove(w) {
			g.mu.Unlock()
			return <-w.ready, nil, nil
		}
		// Still waiting, behind one that doesn't fit: out of turn but it fits
		// now, let it in rather than turn it away.
		var t *Ticket
		var r *Refusal
		if why := g.blocker(length); why != "" {
			r = g.refuse(why, length)
		} else {
			t = g.grant(length, sized)
		}
		g.pump()
		g.mu.Unlock()
		return t, r, nil
	}
}

// remove takes w out of the queue; false when it was already admitted.
// Callers hold mu, and pump afterwards.
func (g *Gate) remove(w *waiter) bool {
	for i, q := range g.queue {
		if q == w {
			g.queue = append(g.queue[:i], g.queue[i+1:]...)
			return true
		}
	}
	return false
}

func (g *Gate) refuse(why string, length int64) *Refusal {
	g.stats.Refused++
	g.refused++
	if g.refusingSince.IsZero() {
		g.refusingSince = time.Now()
		g.logf("refusing new native requests (%s): %s", why, g.describe(length))
	}
	return &Refusal{Reason: why, RetryAfterSec: g.o.RetryAfterSec}
}

func (g *Gate) logf(format string, args ...any) {
	if g.o.Logf != nil {
		g.o.Logf(format, args...)
	}
}

func (g *Gate) describe(length int64) string {
	parts := []string{fmt.Sprintf("%d in flight holding %dMB", g.inflight, g.held/mib)}
	if g.o.BudgetBytes > 0 {
		parts[0] += fmt.Sprintf(" of %dMB", g.o.BudgetBytes/mib)
	}
	parts = append(parts, fmt.Sprintf("%dMB of bodies not yet replying", g.pending/mib))
	if g.o.HighWaterBytes > 0 {
		parts = append(parts, fmt.Sprintf("container %dMB + %dMB coming (high water %dMB)",
			g.memory()/mib, (g.pending+length)*g.o.PendingCopies/mib, g.o.HighWaterBytes/mib))
	}
	parts = append(parts, fmt.Sprintf("%d waiting", len(g.queue)))
	return strings.Join(parts, ", ")
}

// grant admits a body. Callers hold mu.
func (g *Gate) grant(length int64, sized bool) *Ticket {
	g.held += length * g.o.Copies
	g.pending += length
	g.inflight++
	g.stats.Admitted++
	if !g.refusingSince.IsZero() {
		g.logf("admitting native requests again after refusing %d over %ds (%s)", g.refused, int(time.Since(g.refusingSince).Seconds()), g.describe(0))
		g.refusingSince, g.refused = time.Time{}, 0
	}
	return &Ticket{g: g, length: length, sized: sized, pending: true}
}

// pump lets waiters in from the front while they fit. Callers hold mu.
func (g *Gate) pump() {
	for len(g.queue) > 0 && g.blocker(g.queue[0].length) == "" {
		w := g.queue[0]
		g.queue = g.queue[1:]
		w.ready <- g.grant(w.length, w.sized)
	}
	if len(g.queue) == 0 && g.recheck != nil {
		g.recheck.Stop()
		close(g.stop)
		g.recheck, g.stop = nil, nil
	}
}

// startRecheck: memory drops on garbage collection with no request ending,
// so waiters look again every Recheck. Callers hold mu.
func (g *Gate) startRecheck() {
	if g.o.HighWaterBytes <= 0 || g.recheck != nil {
		return
	}
	t, stop := time.NewTicker(g.o.Recheck), make(chan struct{})
	g.recheck, g.stop = t, stop
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				g.mu.Lock()
				if g.stop == stop {
					g.pump()
				}
				g.mu.Unlock()
			}
		}
	}()
}

// Snapshot is the gate's state, for health and tests.
type Snapshot struct {
	Enabled  bool
	Inflight int
	Held     int64
	Pending  int64
	Waiting  int
	Budget   int64
	Stats
}

// Snapshot reads the counters.
func (g *Gate) Snapshot() Snapshot {
	g.mu.Lock()
	defer g.mu.Unlock()
	return Snapshot{Enabled: g.Enabled(), Inflight: g.inflight, Held: g.held, Pending: g.pending, Waiting: len(g.queue), Budget: g.o.BudgetBytes, Stats: g.stats}
}

// Ticket is one admitted request.
type Ticket struct {
	g        *Gate
	length   int64
	sized    bool
	pending  bool
	released bool
}

// NoteBodyLength: the body has been read, n bytes. A stated length only
// grows; the guess for a missing one gives way to the real length.
func (t *Ticket) NoteBodyLength(n int64) {
	g := t.g
	g.mu.Lock()
	defer g.mu.Unlock()
	n = min(n, maxLength)
	if n < 0 || t.released || (t.sized && n <= t.length) {
		return
	}
	t.sized = true
	g.held += (n - t.length) * g.o.Copies
	if t.pending {
		g.pending += n - t.length
	}
	shrank := n < t.length
	t.length = n
	if shrank {
		g.pump()
	}
}

// Replied: the reply has started. What the request holds now shows in
// memory, so it no longer counts as about to allocate. Idempotent.
func (t *Ticket) Replied() {
	g := t.g
	g.mu.Lock()
	defer g.mu.Unlock()
	if !t.pending || t.released {
		return
	}
	t.pending = false
	g.pending -= t.length
	g.pump()
}

// Release: the request is done. Idempotent.
func (t *Ticket) Release() {
	g := t.g
	g.mu.Lock()
	defer g.mu.Unlock()
	if t.released {
		return
	}
	t.released = true
	g.held -= t.length * g.o.Copies
	g.inflight--
	if t.pending {
		t.pending = false
		g.pending -= t.length
	}
	g.pump()
}

// BusyBody is busyResponse's body for a Claude client: Node's own words.
func BusyBody(retryAfterSec int64) []byte {
	type claudeError struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	msg := strings.ReplaceAll(nodeDefaults.BusyMessage, "{s}", strconv.FormatInt(retryAfterSec, 10))
	body, _ := json.Marshal(struct {
		Type  string      `json:"type"`
		Error claudeError `json:"error"`
	}{"error", claudeError{nodeDefaults.BusyErrorType, msg}})
	return body
}

// ContainerAnon is the container's anonymous memory in bytes: cgroup v2's
// memory.stat anon, cgroup v1's total_rss, else this process's resident set.
// Page cache is left out: the kernel reclaims it before it kills anyone.
func ContainerAnon() int64 {
	if n, ok := statField("/sys/fs/cgroup/memory.stat", "anon"); ok {
		return n
	}
	if n, ok := statField("/sys/fs/cgroup/memory/memory.stat", "total_rss"); ok {
		return n
	}
	return selfRSS()
}

func statField(path, field string) (int64, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		name, value, ok := strings.Cut(s.Text(), " ")
		if ok && name == field {
			n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
			return n, err == nil
		}
	}
	return 0, false
}

func selfRSS() int64 {
	raw, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return 0
	}
	pages, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return pages * int64(os.Getpagesize())
}

// ContainerLimit is the container's memory limit in bytes (cgroup v2
// memory.max, cgroup v1 memory.limit_in_bytes), 0 for none, as Node's
// readCgroupMemoryLimit reads it.
func ContainerLimit() int64 {
	for _, path := range []string{"/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"} {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		text := strings.TrimSpace(string(raw))
		if !digits.MatchString(text) {
			return 0
		}
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil || n <= 0 || n >= 1<<60 {
			return 0
		}
		return n
	}
	return 0
}
