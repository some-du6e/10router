package accounts

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// AttemptResult is one account's try, as chatCore reports it to the account
// loop: success, or the status and "[status]: message" error. ResetsAtMs is
// an exact reset the provider named; HeadersTimeout is set when the upstream
// sent no response headers in time.
type AttemptResult struct {
	Success        bool
	Status         int
	Error          string
	ResetsAtMs     float64
	HeadersTimeout bool
	TimeoutStream  bool
}

// Attempt sends the request with one connection. An error is a decline
// (the request goes to Node) or a failure the caller handles.
type Attempt func(ctx context.Context, c *db.Connection) (AttemptResult, error)

// Reply is the Response Node's loop returns for a failure, to be written in
// the client's format: errorResponse(status, message), or with Unavailable
// unavailableResponse(status, message, retryAfter, retryAfterHuman), whose
// message gets " (human)" and a Retry-After.
type Reply struct {
	Status          int
	Message         string
	Unavailable     bool
	RetryAfterMs    float64
	RetryAfterHuman string
}

// ClientMessage is the message the client's error body carries: error.message.
func (r Reply) ClientMessage() string {
	if r.Unavailable {
		return r.Message + " (" + r.RetryAfterHuman + ")"
	}
	if r.Message != "" {
		return r.Message
	}
	return defaultMessage(r.Status)
}

// AccountError is one account's own failure on this request.
type AccountError struct {
	Status int
	Error  string
}

// Outcome is routeSingleModelChat's result for one provider model: success
// on a connection, or the failure as the combo and the limit hold read it
// (a RoutingFailure), with the reply Node would answer.
type Outcome struct {
	Success bool
	Conn    *db.Connection

	Status          int
	Error           string
	Limited         bool
	LimitsExhausted bool
	Unconfigured    bool
	ResetAtMs       float64
	RetryAtMs       float64
	AccountErrors   []AccountError
	Reply           Reply
	// ClientGone: the client hung up; nothing more is tried.
	ClientGone bool
}

// LoopInput is what one model's account loop reads.
type LoopInput struct {
	Provider, Model string
	// Body is the client's body as routing reads it (cache affinity, the
	// prompt size estimate, the cache TTL).
	Body *claudeprep.Value
	// Headers are the client's headers, lowercase names.
	Headers map[string]string
	// Tenant is the client's key ("" for none).
	Tenant    string
	Settings  Settings
	RequestID string
	// ByteSent reports whether a byte of the reply has gone to the client:
	// until then a failure the gateway doesn't model can still go to Node.
	ByteSent func() bool
	// Sleep waits ms or until ctx ends (the warm-key wait).
	Sleep func(ctx context.Context, ms float64) error
	// SharesOneUpstream is keysShareOneUpstream for the provider.
	SharesOneUpstream func(ctx context.Context) (bool, error)
}

// Handoff is a failure Node must see again for itself: the request goes to
// Node, which redoes it with its own state (dead-key evidence).
type Handoff struct{ Reason string }

func (h *Handoff) Error() string { return "accounts: hand to Node: " + h.Reason }

// RunModel is routeSingleModelChat's account loop for one provider model
// (a combo member): model hang, then one pass over the provider's keys.
func (a *Accounts) RunModel(ctx context.Context, in LoopInput, attempt Attempt) (Outcome, error) {
	if ModelIDProblem(in.Model) {
		return Outcome{}, declined("a model id Node refuses (modelIdProblem)")
	}
	now := a.nowMs()
	hang := a.Hang.Check(in.Provider, in.Model, in.RequestID, now)
	if hang.Blocked {
		return a.hungOutcome(in, hang), nil
	}
	defer a.Hang.ReleaseProbe(in.Provider, in.Model, in.RequestID)
	avoid := map[string]bool{}
	for _, k := range hang.AvoidKeys {
		avoid[k] = true
	}
	return a.accountPass(ctx, in, attempt, avoid)
}

// hungOutcome is modelHungResult: a 504 without calling the upstream.
func (a *Accounts) hungOutcome(in LoopInput, h HangStatus) Outcome {
	reason := h.Reason
	if reason == "" {
		reason = tbl.HeadersTimeout.Text
	}
	message := fmt.Sprintf("[%s/%s] is not responding upstream: %s", in.Provider, in.Model, reason)
	next := "a check is running"
	if !h.Checking {
		next = fmt.Sprintf("next check in %ds", int(math.Max(1, math.Ceil((h.RetryAtMs-a.nowMs())/1000))))
	}
	return Outcome{
		Status: 504, Error: message + " (" + next + ")",
		Reply: Reply{Status: 504, Message: message, Unavailable: true, RetryAfterMs: h.RetryAtMs, RetryAfterHuman: next},
	}
}

type accountFailure struct {
	account string
	status  int
	err     string
}

func (a *Accounts) accountPass(ctx context.Context, in LoopInput, attempt Attempt, avoid map[string]bool) (Outcome, error) {
	cacheKey, err := CacheAffinityKey(in.Provider, in.Model, in.Body, in.Headers, in.Tenant)
	if err != nil {
		return Outcome{}, err
	}
	var cacheWaited float64
	promptTokens := -1.0
	waitBudget := func() float64 {
		return WarmWaitBudget(cacheWaited, func() float64 {
			if promptTokens < 0 {
				promptTokens = EstimatePromptTokens(in.Body)
			}
			return promptTokens
		})
	}
	exclude := map[string]bool{}
	var failures []accountFailure
	failureIndex := map[string]int{}
	var accountErrors []AccountError
	lastStatus, lastError := 0, ""
	hasLast := false
	lockedUntil := 0.0
	keysSinceTimeout := 0
	tally := newSameRequestTally()
	var shared *bool

	for {
		if err := ctx.Err(); err != nil {
			return Outcome{ClientGone: true, Status: 499, Error: "Request aborted", AccountErrors: accountErrors}, nil
		}
		now := a.nowMs()
		warm := a.Warm.Get(cacheKey, now)
		opts := SelectOptions{Exclude: exclude, Warm: warm, Avoid: avoid}
		if len(warm) > 0 {
			opts.MaxWarmWaitMs = waitBudget()
		}
		pick, err := a.Select(ctx, in.Provider, in.Model, in.Settings, opts)
		if err != nil {
			return Outcome{}, err
		}
		if pick.WarmRetryAtMs > 0 {
			wait := math.Max(0, pick.WarmRetryAtMs-a.nowMs())
			slept := a.nowMs()
			if err := in.Sleep(ctx, wait); err != nil {
				continue
			}
			cacheWaited += math.Max(wait, a.nowMs()-slept)
			continue
		}
		if pick.Conn == nil {
			return a.noAccount(in, pick.AllLocked, exclude, failures, accountErrors, lastStatus, lastError, hasLast, lockedUntil), nil
		}
		c := conn{pick.Conn}
		res, err := attempt(ctx, pick.Conn)
		if err != nil {
			return Outcome{}, err
		}
		if res.Success {
			a.Hang.NoteServed(in.Provider, in.Model)
			if cacheKey != "" {
				a.Warm.Remember(cacheKey, c.ID, CacheTTLMs(in.Body), a.nowMs())
			}
			return Outcome{Success: true, Conn: pick.Conn, AccountErrors: accountErrors}, nil
		}
		if ctx.Err() != nil {
			return Outcome{ClientGone: true, Status: 499, Error: "Request aborted", AccountErrors: accountErrors}, nil
		}
		// Dead-key evidence is Node's: before the first byte, Node redoes it.
		if AuthRefusal(res.Status) && (in.ByteSent == nil || !in.ByteSent()) {
			return Outcome{}, &Handoff{Reason: fmt.Sprintf("a %d from the upstream (dead-key evidence is kept by Node)", res.Status)}
		}
		accountErrors = append(accountErrors, AccountError{Status: res.Status, Error: res.Error})

		cooldown := 0.0
		// A request error on a custom endpoint tries the next key but locks nothing.
		if !IsRequestError(res.Status, res.Error) {
			m, err := a.MarkUnavailable(ctx, c.ID, in.Provider, res.Status, res.Error, in.Model, res.ResetsAtMs)
			if err != nil {
				return Outcome{}, err
			}
			cooldown = m.CooldownMs
		}
		now = a.nowMs()
		unlockAt := res.ResetsAtMs
		if unlockAt == 0 && cooldown > 0 {
			unlockAt = now + cooldown
		}
		if unlockAt != 0 && (lockedUntil == 0 || unlockAt < lockedUntil) {
			lockedUntil = unlockAt
		}

		var hangSt HangStatus
		hung := false
		if res.HeadersTimeout {
			hangSt, hung = a.Hang.NoteHeadersTimeout(in.Provider, in.Model, in.RequestID, c.ID, res.TimeoutStream, statusPrefixRe.ReplaceAllLiteralString(res.Error, ""), now)
		}
		if keysSinceTimeout > 0 || res.HeadersTimeout {
			keysSinceTimeout++
		}

		failure := accountFailure{account: c.displayName(), status: res.Status, err: res.Error}
		if i, seen := failureIndex[c.ID]; seen {
			failures[i] = failure
		} else {
			failureIndex[c.ID] = len(failures)
			failures = append(failures, failure)
		}
		if hung {
			return a.hungOutcome(in, hangSt).withErrors(accountErrors), nil
		}
		if keysSinceTimeout >= tbl.HeadersTimeout.MaxKeysPerRequest {
			msg := summarize(in.Provider, in.Model, failures)
			return Outcome{Status: 504, Error: msg, AccountErrors: accountErrors, Reply: Reply{Status: 504, Message: msg}}, nil
		}
		psd := c.ProviderSpecificData()
		agreement := tally.note(c.ID, UpstreamOf(psd), res.Status, res.Error)
		if agreement == Normalized && shared == nil {
			s, err := in.SharesOneUpstream(ctx)
			if err != nil {
				return Outcome{}, err
			}
			shared = &s
		}
		if agreement == Exact || (agreement == Normalized && *shared) {
			return Outcome{Status: res.Status, Error: res.Error, AccountErrors: accountErrors, Reply: Reply{Status: res.Status, Message: res.Error}}, nil
		}
		// A warm key just rate-limited for a short while stays in play.
		isWarm := false
		for _, id := range warm {
			isWarm = isWarm || id == c.ID
		}
		if cooldown > 0 && isWarm && IsLimitError(res.Status, res.Error) && WarmRetryAt(a.nowMs()+cooldown, waitBudget(), a.nowMs()) {
			lastError, lastStatus, hasLast = res.Error, res.Status, true
			continue
		}
		exclude[c.ID] = true
		lastError, lastStatus, hasLast = res.Error, res.Status, true
	}
}

func (o Outcome) withErrors(e []AccountError) Outcome {
	o.AccountErrors = e
	return o
}

// noAccount is the pass's end when selection found no key: every key locked
// (allRateLimited), none configured, or none left.
func (a *Accounts) noAccount(in LoopInput, locked *AllLocked, exclude map[string]bool, failures []accountFailure, accountErrors []AccountError, lastStatus int, lastError string, hasLast bool, lockedUntil float64) Outcome {
	if locked != nil {
		st, errMsg, swapped, hasErr := allLockedError(lastStatus, lastError, hasLast, locked, failures)
		summary, hasSummary := "", len(failures) > 0
		if hasSummary {
			summary = summarize(in.Provider, in.Model, failures)
		}
		summarized := hasSummary && !(swapped && hasErr)
		msg := "Unavailable"
		if hasErr {
			msg = errMsg
		}
		prefixed := fmt.Sprintf("[%s/%s] %s", in.Provider, in.Model, msg)
		if summarized {
			msg, prefixed = summary, summary
		}
		exhausted := locked.AllLimitsExhausted
		for _, f := range failures {
			exhausted = exhausted && IsLimitError(f.status, f.err)
		}
		return Outcome{
			Status: st, Error: msg, Limited: IsLimitError(st, msg), LimitsExhausted: exhausted,
			ResetAtMs: locked.ProviderResetAtMs, RetryAtMs: locked.RetryAfterMs, AccountErrors: accountErrors,
			Reply: Reply{Status: st, Message: prefixed, Unavailable: true, RetryAfterMs: locked.RetryAfterMs, RetryAfterHuman: locked.RetryAfterHuman},
		}
	}
	if len(exclude) == 0 {
		msg := "No active credentials for provider: " + in.Provider
		return Outcome{Unconfigured: true, Status: 404, Error: msg, AccountErrors: accountErrors, Reply: Reply{Status: 404, Message: msg}}
	}
	st, _, _, _ := allLockedError(lastStatus, lastError, hasLast, nil, failures)
	msg := summarize(in.Provider, in.Model, failures)
	allLimited := len(failures) > 0
	for _, f := range failures {
		allLimited = allLimited && IsLimitError(f.status, f.err)
	}
	return Outcome{Status: st, Error: msg, Limited: allLimited, LimitsExhausted: allLimited, RetryAtMs: lockedUntil, AccountErrors: accountErrors, Reply: Reply{Status: st, Message: msg}}
}

// allLockedError is limitHold.js's allLockedError: which status and error
// the every-key-locked answer reports. hasErr is false for a null error.
func allLockedError(lastStatus int, lastError string, hasLast bool, locked *AllLocked, failures []accountFailure) (status int, errMsg string, swapped, hasErr bool) {
	soonest := 0
	if locked != nil {
		if f, ok := locked.LastErrorCode.(float64); ok && f == math.Trunc(f) {
			soonest = int(f)
		}
	}
	retryable := func(s int) bool { return s == 429 || s >= 500 }
	lockedErr, lockedHasErr := "", false
	if locked != nil {
		if s, ok := locked.LastError.(string); ok && s != "" {
			lockedErr, lockedHasErr = s, true
		}
	}
	authFailed := lastStatus == 401 || lastStatus == 403
	if authFailed {
		if soonest != 0 && retryable(soonest) && locked.LastErrorOwn {
			return soonest, lockedErr, true, lockedHasErr
		}
		for _, f := range failures {
			if retryable(f.status) {
				return f.status, f.err, true, f.err != ""
			}
		}
	}
	anyLimit := false
	for _, f := range failures {
		anyLimit = anyLimit || IsLimitError(f.status, f.err)
	}
	if (authFailed || lastStatus == 404) && !anyLimit {
		var pick *accountFailure
		for i := range failures {
			if IsRequestError(failures[i].status, failures[i].err) && failures[i].status != 404 {
				pick = &failures[i]
				break
			}
		}
		if pick == nil && authFailed {
			for i := range failures {
				if IsRequestError(failures[i].status, failures[i].err) {
					pick = &failures[i]
					break
				}
			}
		}
		if pick != nil {
			return pick.status, pick.err, true, pick.err != ""
		}
	}
	status = lastStatus
	if status == 0 {
		status = soonest
	}
	if status == 0 {
		status = 503
	}
	if hasLast && lastError != "" {
		return status, lastError, false, true
	}
	return status, lockedErr, false, lockedHasErr
}

// summarize is summarizeAccountFailures.
func summarize(provider, model string, failures []accountFailure) string {
	if len(failures) == 0 {
		return fmt.Sprintf("All accounts unavailable for [%s/%s]", provider, model)
	}
	parts := make([]string, len(failures))
	for i, f := range failures {
		name := f.account
		if name == "" {
			name = "Unnamed account"
		}
		label := "provider error"
		if f.status != 0 {
			label = fmt.Sprintf("HTTP %d", f.status)
		}
		parts[i] = fmt.Sprintf("%s (%s): %s", name, label, extractProviderMessage(f.err))
	}
	return fmt.Sprintf("All %d accounts unavailable for [%s/%s]. %s", len(failures), provider, model, strings.Join(parts, " | "))
}

// extractProviderMessage is accountFailureSummary.js's: from the first "{",
// a JSON body's error.message or message, else the text.
func extractProviderMessage(text string) string {
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return text
	}
	v, err := claudeprep.Parse([]byte(text[start:]))
	if err != nil {
		return text
	}
	if e := v.Get("error"); e.IsObject() || e.IsArray() {
		if m := e.Get("message"); m.Truthy() {
			return jsDisplay(m)
		}
	}
	if m := v.Get("message"); m.Truthy() {
		return jsDisplay(m)
	}
	return text
}

// jsDisplay is how a template literal writes a value.
func jsDisplay(v *claudeprep.Value) string {
	if v.IsString() {
		return v.Str()
	}
	if v.IsNumber() {
		return string(jsjson.Marshal(v.Float()))
	}
	if v.Kind() == claudeprep.KindBool {
		if v.Truthy() {
			return "true"
		}
		return "false"
	}
	return "[object Object]"
}
