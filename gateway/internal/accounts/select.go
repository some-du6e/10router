package accounts

import (
	"context"
	"math"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Store is the database the accounts read and write.
type Store interface {
	ListConnections(ctx context.Context, provider string, active *bool) ([]*db.Connection, error)
	UpdateConnection(ctx context.Context, id string, u db.ConnectionUpdate) (*db.Connection, error)
}

// Accounts is one gateway's account state: the per-provider selection
// mutexes, warm keys, model hang and the keys it has seen serve. Node keeps
// the same in its own memory; a provider served natively has it here alone.
type Accounts struct {
	Store Store
	// Now is the clock (time.Now when nil).
	Now func() time.Time
	// Random is Math.random for the warm-wait jitter (rand when nil).
	Random func() float64

	mutexes sync.Map // provider → *sync.Mutex

	Warm *WarmKeys
	Hang *ModelHang

	servedMu sync.Mutex
	served   map[string]bool
}

// New makes the account state over store.
func New(store Store) *Accounts {
	return &Accounts{Store: store, Warm: NewWarmKeys(), Hang: NewModelHang(), served: map[string]bool{}}
}

func (a *Accounts) nowMs() float64 {
	if a.Now != nil {
		return float64(a.Now().UnixMilli())
	}
	return float64(time.Now().UnixMilli())
}

func (a *Accounts) random() float64 {
	if a.Random != nil {
		return a.Random()
	}
	return rand.Float64()
}

// SelectOptions are getProviderCredentials' options for the hot path.
type SelectOptions struct {
	// Exclude are connections this pass already tried.
	Exclude map[string]bool
	// Warm are keys holding this conversation's prompt cache, most recently
	// used last (WarmKeys.Get).
	Warm []string
	// MaxWarmWaitMs: when the pick isn't warm and a warm key is only briefly
	// rate-limited, return WarmRetryAtMs instead of a key.
	MaxWarmWaitMs float64
	// Avoid are keys to rank after every other healthy key (model hang).
	Avoid map[string]bool
	// Check runs on the pick before Select writes or returns it
	// (LoopInput.Check): a decline then leaves no round-robin write behind.
	Check func(*db.Connection) error
}

// AllLocked is getProviderCredentials' allRateLimited answer.
type AllLocked struct {
	RetryAfterMs       float64
	RetryAfterHuman    string
	AllLimitsExhausted bool
	// ProviderResetAtMs is getNextAccountReset (0: unknown).
	ProviderResetAtMs float64
	LastError         any // the stored lastError, or nil
	LastErrorCode     any // the stored errorCode, or nil
	LastErrorOwn      bool
}

// Pick is what selection settled on: a connection, a warm key to wait for,
// every key locked, or none at all (all nil).
type Pick struct {
	Conn          *db.Connection
	WarmRetryAtMs float64
	AllLocked     *AllLocked
}

// Settings are the settings selection reads.
type Settings interface {
	Get(key string) (any, bool)
}

func providerOverride(s Settings, provider string) *jsjson.Object {
	v, _ := s.Get("providerStrategies")
	o, _ := v.(*jsjson.Object)
	p, _ := o.Get(provider)
	po, _ := p.(*jsjson.Object)
	return po
}

var truthyOr = jsjson.Or

// Strategy is the provider's fallbackStrategy: its own, else Global, else
// fill-first. Only fill-first and round-robin are served natively.
func Strategy(s Settings, provider string) (string, error) {
	own, _ := providerOverride(s, provider).Get("fallbackStrategy")
	global, _ := s.Get("fallbackStrategy")
	v := truthyOr(own, truthyOr(global, "fill-first"))
	str, ok := v.(string)
	switch {
	case !ok:
		return "", declined("a fallbackStrategy that isn't a string")
	case str == "fill-first" || str == "round-robin":
		return str, nil
	case str == "soonest-reset":
		return "", declined("the soonest-reset strategy (it reads quota tracking Node keeps)")
	}
	// Any other value falls to fill-first in Node's branches.
	return "fill-first", nil
}

func stickyLimit(s Settings, provider string) (float64, error) {
	own, _ := providerOverride(s, provider).Get("stickyRoundRobinLimit")
	global, _ := s.Get("stickyRoundRobinLimit")
	v := truthyOr(own, truthyOr(global, 3.0))
	f, ok := v.(float64)
	if !ok {
		return 0, declined("a stickyRoundRobinLimit that isn't a number")
	}
	return f, nil
}

// Select is getProviderCredentials for an openai-compatible node's keys.
// It holds the provider's mutex for the whole pick, as Node does, so a
// round-robin pick reads and writes its counters alone.
func (a *Accounts) Select(ctx context.Context, provider, model string, s Settings, o SelectOptions) (Pick, error) {
	if !strings.HasPrefix(provider, "openai-compatible-") {
		return Pick{}, declined("provider %s is not an openai-compatible node", provider)
	}
	mu, _ := a.mutexes.LoadOrStore(provider, &sync.Mutex{})
	m := mu.(*sync.Mutex)
	m.Lock()
	defer m.Unlock()

	active := true
	rows, err := a.Store.ListConnections(ctx, provider, &active)
	if err != nil {
		return Pick{}, err
	}
	if len(rows) == 0 {
		return Pick{}, nil
	}
	conns := make([]conn, len(rows))
	for i, r := range rows {
		conns[i] = conn{r}
		if err := conns[i].checkDates(); err != nil {
			return Pick{}, err
		}
		if conns[i].hasDemotion() {
			return Pick{}, declined("connection %s has a demotion record (dead-key evidence is Node's)", r.ID)
		}
	}
	strategy, err := Strategy(s, provider)
	if err != nil {
		return Pick{}, err
	}
	now := a.nowMs()

	usable := func(c conn) bool { return !o.Exclude[c.ID] && !c.modelLockActive(model, now) }
	var available, avoided []conn
	for _, c := range conns {
		if !usable(c) {
			continue
		}
		if o.Avoid[c.ID] {
			avoided = append(avoided, c)
		} else {
			available = append(available, c)
		}
	}
	// notAvoided first; with no demotions, every usable key is "notDemoted".
	if len(available) == 0 {
		available = avoided
	}

	if len(available) == 0 {
		return Pick{AllLocked: allLocked(conns, model, now)}, nil
	}

	warm := map[string]bool{}
	for _, id := range o.Warm {
		warm[id] = true
	}
	var pick conn
	if len(warm) > 0 {
		recency := func(c conn) int {
			at := -1
			for i, id := range o.Warm {
				if id == c.ID {
					at = i
				}
			}
			return at
		}
		var warmConn *conn
		if strategy == "round-robin" {
			for i := range available {
				c := available[i]
				if warm[c.ID] && (warmConn == nil || recency(c) > recency(*warmConn)) {
					warmConn = &available[i]
				}
			}
		}
		var choice *conn
		if strategy == "round-robin" {
			choice = warmConn
		} else {
			choice = &available[0]
		}
		if choice == nil || !warm[choice.ID] {
			if o.MaxWarmWaitMs > 0 {
				if at, ok := a.warmRetry(conns, model, strategy, warm, o, now); ok {
					return Pick{WarmRetryAtMs: at}, nil
				}
			}
		}
		if warmConn != nil {
			return checked(o, warmConn.Connection)
		}
	}

	switch strategy {
	case "round-robin":
		return a.roundRobin(ctx, available, s, provider, o)
	default:
		pick = available[0]
	}
	return checked(o, pick.Connection)
}

// checked is the pick after o.Check.
func checked(o SelectOptions, c *db.Connection) (Pick, error) {
	if o.Check != nil {
		if err := o.Check(c); err != nil {
			return Pick{}, err
		}
	}
	return Pick{Conn: c}, nil
}

// warmRetry is the warm-key wait: a warm key only briefly rate-limited, with
// no key the strategy ranks ahead of it usable or freeing up within one slack.
func (a *Accounts) warmRetry(conns []conn, model, strategy string, warm map[string]bool, o SelectOptions, now float64) (float64, bool) {
	ahead := func(x, y conn) bool {
		if strategy == "round-robin" {
			return false
		}
		return x.priority()-y.priority() < 0
	}
	servable := func(c conn) bool { return !o.Exclude[c.ID] }
	jitter := warmJitterMs(a.random())
	var candidates []conn
	for _, c := range conns {
		if warm[c.ID] && !o.Avoid[c.ID] && servable(c) && c.limitLocked(model, now) {
			candidates = append(candidates, c)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].modelLockUntil(model) < candidates[j].modelLockUntil(model) })
	for _, c := range candidates {
		lockEnd := c.modelLockUntil(model)
		earliest, ok := warmRetryAt(lockEnd, o.MaxWarmWaitMs, 0, now)
		if !ok {
			break
		}
		margin := tbl.CacheAffinity.LockSlackMs
		betterFreeAt := math.Inf(1)
		for _, k := range conns {
			if k.ID != c.ID && servable(k) && ahead(k, c) {
				betterFreeAt = math.Min(betterFreeAt, k.modelLockUntil(model))
			}
		}
		if betterFreeAt <= earliest+margin {
			continue
		}
		at, _ := warmRetryAt(lockEnd, o.MaxWarmWaitMs, math.Min(jitter, betterFreeAt-margin-earliest), now)
		return at, true
	}
	return 0, false
}

// roundRobin is the round-robin branch: stay on the most recently used key
// until its consecutive uses reach the sticky limit, else move to the least
// recently used. The counters are written before the pick returns.
func (a *Accounts) roundRobin(ctx context.Context, available []conn, s Settings, provider string, o SelectOptions) (Pick, error) {
	limit, err := stickyLimit(s, provider)
	if err != nil {
		return Pick{}, err
	}
	lastUsed := func(c conn) (float64, bool) {
		v := c.get("lastUsedAt")
		if !jsjson.Truthy(v) {
			return 0, false
		}
		return dateMs(v), true
	}
	byRecency := append([]conn(nil), available...)
	sort.SliceStable(byRecency, func(i, j int) bool {
		x, xok := lastUsed(byRecency[i])
		y, yok := lastUsed(byRecency[j])
		switch {
		case !xok && !yok:
			return byRecency[i].priority()-byRecency[j].priority() < 0
		case !xok:
			return false
		case !yok:
			return true
		}
		return y-x < 0
	})
	current := byRecency[0]
	count, _ := current.num("consecutiveUseCount")
	_, currentUsed := lastUsed(current)
	nowISO := isoMs(a.nowMs())
	var pick conn
	var nextCount float64
	if currentUsed && count < limit {
		pick, nextCount = current, count+1
	} else {
		oldest := append([]conn(nil), available...)
		sort.SliceStable(oldest, func(i, j int) bool {
			x, xok := lastUsed(oldest[i])
			y, yok := lastUsed(oldest[j])
			switch {
			case !xok && !yok:
				return oldest[i].priority()-oldest[j].priority() < 0
			case !xok:
				return true
			case !yok:
				return false
			}
			return x-y < 0
		})
		pick, nextCount = oldest[0], 1
	}
	if o.Check != nil {
		if err := o.Check(pick.Connection); err != nil {
			return Pick{}, err
		}
	}
	// Node writes the counters whether or not the client is still there.
	if _, err := a.Store.UpdateConnection(context.WithoutCancel(ctx), pick.ID, db.ConnectionUpdate{Set: []jsjson.Member{
		{Key: "lastUsedAt", Value: nowISO}, {Key: "consecutiveUseCount", Value: nextCount},
	}}); err != nil {
		return Pick{}, err
	}
	return Pick{Conn: pick.Connection}, nil
}

// allLocked is the every-key-locked answer: when the soonest one frees up,
// and which stored error to report.
func allLocked(conns []conn, model string, now float64) *AllLocked {
	type free struct {
		c     conn
		until float64
	}
	var frees []free
	for _, c := range conns {
		if c.modelLockActive(model, now) {
			if until := c.modelLockUntil(model); until > now {
				frees = append(frees, free{c, until})
			}
		}
	}
	if len(frees) == 0 {
		return nil
	}
	earliest := frees[0].until
	for _, f := range frees[1:] {
		earliest = math.Min(earliest, f.until)
	}
	type report struct {
		code, err         any
		limit, ranks, own bool
	}
	reportOf := func(c conn) report {
		limited := c.limitLocked(model, now)
		ownLock := c.ownLockEnd(model)
		noHeadersLock := ownLock > now && ownLock >= c.modelLockUntil(model) && c.get(noHeadersPrefix+scope(model)) == true
		code, _ := c.num("errorCode")
		lastErr, _ := c.get("lastError").(string)
		if !limited && noHeadersLock {
			e := any("[504]: " + tbl.HeadersTimeout.Text + " (headers timeout)")
			if IsHeadersTimeout(int(code), lastErr) {
				e = c.get("lastError")
			}
			return report{code: 504.0, err: e, ranks: true, own: true}
		}
		authCode := code == 401 || code == 403
		retryable := code == 429 || code >= 500
		if limited && !retryable && !IsLimitError(int(code), lastErr) {
			return report{code: 429.0, err: "Rate limited on " + modelOrAll(model), limit: true, own: true}
		}
		unflagged := !limited && c.modelLockActive(model, now)
		otherModel := unflagged && code == 429
		maybeOther := unflagged && code >= 500
		r := report{limit: limited && !authCode, ranks: !otherModel, own: !otherModel && !maybeOther}
		if jsjson.Truthy(c.get("errorCode")) {
			r.code = c.get("errorCode")
		}
		if jsjson.Truthy(c.get("lastError")) {
			r.err = c.get("lastError")
		}
		return r
	}
	soonest := func(filter func(free) bool) *free {
		var best *free
		for i := range frees {
			if filter(frees[i]) && (best == nil || frees[i].until < best.until) {
				best = &frees[i]
			}
		}
		return best
	}
	has := func(r report) bool { return r.code != nil || r.err != nil }
	pick := soonest(func(f free) bool { return reportOf(f.c).limit })
	if pick == nil {
		pick = soonest(func(f free) bool { r := reportOf(f.c); return r.ranks && has(r) })
	}
	if pick == nil {
		pick = soonest(func(f free) bool { return has(reportOf(f.c)) })
	}
	if pick == nil {
		pick = soonest(func(free) bool { return true })
	}
	r := reportOf(pick.c)
	out := &AllLocked{
		RetryAfterMs:    earliest,
		RetryAfterHuman: FormatRetryAfter(earliest, now),
		LastError:       r.err,
		LastErrorCode:   r.code,
		LastErrorOwn:    r.own,
	}
	// allLimitsExhausted: every account locked on a limit for this model
	// (Node's (!locked || limitedLock) && limitedLock, with no quota
	// tracking for these providers, is limitedLock).
	out.AllLimitsExhausted = len(conns) > 0
	for _, c := range conns {
		limitedLock := c.modelLockActive(model, now) &&
			((c.ownLockEnd(model) > now && c.get(modelLimitPrefix+scope(model)) == true) ||
				(dateMs(c.get(ModelLockAll)) > now && c.get(modelLimitPrefix+"__all") == true))
		if !limitedLock {
			out.AllLimitsExhausted = false
		}
	}
	out.ProviderResetAtMs = nextAccountReset(conns, model, now)
	return out
}

func modelOrAll(model string) string {
	if model == "" {
		return "all models"
	}
	return model
}

// nextAccountReset is getNextAccountReset: the soonest reset, when every
// account has one still ahead.
func nextAccountReset(conns []conn, model string, now float64) float64 {
	if len(conns) == 0 {
		return 0
	}
	soonest := math.Inf(1)
	for _, c := range conns {
		latest := 0.0
		for _, key := range []string{providerResetPrefix + scope(model), providerResetPrefix + "__all"} {
			if t := dateMs(c.get(key)); t > now {
				latest = math.Max(latest, t)
			}
		}
		if latest == 0 {
			return 0
		}
		soonest = math.Min(soonest, latest)
	}
	return soonest
}
