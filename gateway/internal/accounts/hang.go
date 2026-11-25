package accounts

import (
	"math"
	"sync"
)

// ModelHang is modelHang.js: header timeouts per provider/model, and whether
// they made the model hung. In memory, per process.
type ModelHang struct {
	mu     sync.Mutex
	models map[string]*hangEntry
	// BudgetMs is UPSTREAM_STREAM_HEADERS_TIMEOUT_MS as this process reads
	// it (upstream.HeadersBudget(env, true).Ms): a probe's lease and the
	// Retry-After while one runs go by it until the executor reports its own.
	// NewModelHang starts it at Node's default.
	BudgetMs float64
}

type hangEntry struct {
	requests, keys map[string]bool
	lastAt         float64
	reason         string
	hung           *hung
}

type hung struct {
	level        int
	until        float64
	reason       string
	stalled      map[string]bool
	stalledOrder []string
	probe        *hangProbe
}

type hangProbe struct {
	id       string
	at       float64
	budgetMs float64
}

const maxHangModels = 10 * 1000

// NewModelHang makes an empty tracker.
func NewModelHang() *ModelHang {
	return &ModelHang{models: map[string]*hangEntry{}, BudgetMs: tbl.UpstreamStreamHeadersTimeoutMs}
}

func hangKey(provider, model string) string { return provider + "|" + model }

func hungWindowMs(level int) float64 {
	w := tbl.HeadersTimeout.HungWindowMs
	return w[min(level, len(w)-1)]
}

func leaseMs(p *hangProbe) float64 {
	return math.Max(tbl.HeadersTimeout.ProbeLeaseMs, p.budgetMs+tbl.HeadersTimeout.ProbeLeaseMarginMs)
}

// HangStatus is what a request blocked by a hung model is told.
type HangStatus struct {
	Blocked   bool
	Checking  bool
	RetryAtMs float64
	Reason    string
	// Probe: this request is the one probing the hung model.
	Probe bool
	// AvoidKeys: keys to try last.
	AvoidKeys []string
}

func statusOf(h *hung, now, budgetMs float64) HangStatus {
	if now < h.until {
		return HangStatus{RetryAtMs: h.until, Reason: h.reason}
	}
	probeEnd := now + budgetMs
	if h.probe != nil {
		probeEnd = h.probe.at + h.probe.budgetMs
	}
	return HangStatus{Checking: true, RetryAtMs: math.Max(now+1000, probeEnd), Reason: h.reason}
}

// Check is checkModelHang: may this request call the upstream for the model?
func (m *ModelHang) Check(provider, model, requestID string, now float64) HangStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.models[hangKey(provider, model)]
	if e == nil || e.hung == nil {
		st := HangStatus{}
		if e != nil && now-e.lastAt <= tbl.HeadersTimeout.ResetAfterMs {
			st.AvoidKeys = keysOf(e.keys)
		}
		return st
	}
	h := e.hung
	probe := HangStatus{Probe: true, AvoidKeys: append([]string(nil), h.stalledOrder...)}
	if h.probe != nil && h.probe.id == requestID {
		return probe
	}
	if now < h.until || (h.probe != nil && now-h.probe.at < leaseMs(h.probe)) {
		st := statusOf(h, now, m.BudgetMs)
		st.Blocked = true
		return st
	}
	h.probe = &hangProbe{id: requestID, at: now, budgetMs: m.BudgetMs}
	return probe
}

// keysOf is [...set] in no particular order: every caller reads the keys as
// a set (the account loop's avoid list).
func keysOf(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	return out
}

// NoteHeadersTimeout is noteHeadersTimeout: this request got no headers
// from the model on this key. hung reports the hang it made or is in.
func (m *ModelHang) NoteHeadersTimeout(provider, model, requestID, connectionID string, stream bool, reason string, now float64) (HangStatus, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := hangKey(provider, model)
	e := m.models[key]
	if e != nil && e.hung != nil {
		h := e.hung
		if !h.stalled[connectionID] {
			h.stalled[connectionID] = true
			h.stalledOrder = append(h.stalledOrder, connectionID)
		}
		if h.probe != nil && h.probe.id == requestID {
			level := h.level + 1
			if now-h.until > tbl.HeadersTimeout.ResetAfterMs {
				level = 0
			}
			r := h.reason
			if reason != "" {
				r = reason
			}
			e.hung = &hung{level: level, until: now + hungWindowMs(level), reason: r, stalled: h.stalled, stalledOrder: h.stalledOrder}
		}
		return statusOf(e.hung, now, m.BudgetMs), true
	}
	if !stream {
		return HangStatus{}, false
	}
	if e == nil || now-e.lastAt > tbl.HeadersTimeout.ResetAfterMs {
		if e == nil && len(m.models) >= maxHangModels {
			m.models = map[string]*hangEntry{}
		}
		e = &hangEntry{requests: map[string]bool{}, keys: map[string]bool{}, lastAt: now, reason: reason}
		m.models[key] = e
	}
	e.lastAt = now
	if reason != "" {
		e.reason = reason
	}
	if len(e.requests) < tbl.HeadersTimeout.HungAfterRequests {
		e.requests[requestID] = true
	}
	e.keys[connectionID] = true
	if len(e.requests) < tbl.HeadersTimeout.HungAfterRequests || len(e.keys) < tbl.HeadersTimeout.HungAfterKeys {
		return HangStatus{}, false
	}
	stalled := map[string]bool{}
	var order []string
	for k := range e.keys {
		stalled[k] = true
		order = append(order, k)
	}
	e.hung = &hung{level: 0, until: now + hungWindowMs(0), reason: e.reason, stalled: stalled, stalledOrder: order}
	e.requests, e.keys = map[string]bool{}, map[string]bool{}
	return statusOf(e.hung, now, m.BudgetMs), true
}

// NoteProbeBudget is noteProbeBudget: the probe's call has this budget.
func (m *ModelHang) NoteProbeBudget(provider, model, requestID string, budgetMs, now float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.models[hangKey(provider, model)]; e != nil && e.hung != nil && e.hung.probe != nil && e.hung.probe.id == requestID && budgetMs > 0 {
		e.hung.probe.at, e.hung.probe.budgetMs = now, budgetMs
	}
}

// NoteServed is noteModelServed: the model served, it isn't hung.
func (m *ModelHang) NoteServed(provider, model string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.models, hangKey(provider, model))
}

// ReleaseProbe is releaseProbe: the probe ended some other way.
func (m *ModelHang) ReleaseProbe(provider, model, requestID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.models[hangKey(provider, model)]; e != nil && e.hung != nil && e.hung.probe != nil && e.hung.probe.id == requestID {
		e.hung.probe = nil
	}
}
