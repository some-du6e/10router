package combo

import (
	"context"
	"strconv"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/accounts"
	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Target is what a model id routes to: one provider model (a leaf), or a
// combo's members in the order Node tries them.
type Target struct {
	// ID is the id as the client or the combo names it.
	ID string
	// Provider and Model: the leaf as getModelInfo resolves it.
	Provider, Model string
	// Combo is the combo's lookup name ("" for a leaf).
	Combo   string
	Members []*Target
}

// PlanInput is what Plan reads.
type PlanInput struct {
	Config   *Config
	Settings accounts.Settings
	// Model is chat.ts's modelStr: body.model with the [1m] marker off.
	Model   string
	Body    *claudeprep.Value
	Headers map[string]string
	// KeyLimitHold is the client key's own limit-hold setting (nil: none, or
	// no key).
	KeyLimitHold *bool
}

// Plan is chat.ts's handleRoutedChat and routeSingleModelChat up to the
// account loop, for the requests phase 2 serves: a user combo of fallback
// combos down to openai-compatible nodes, or one such node's model.
//
// The whole tree is walked before anything is sent, and everything Node
// would refuse, or route by state Go doesn't keep, is a decline:
//   - a bare id that is no user combo (an auto combo may form for it);
//   - a member Node answers with a 400: no provider and no combo, an id
//     modelIdProblem refuses, a combo nested in itself or past
//     MAX_COMBO_DEPTH;
//   - a provider that isn't an openai-compatible node;
//   - the fusion and round-robin strategies;
//   - a request that may need a model capability (MayNeedCapability), so
//     the capacity adapter and the auto-switch reorder stay Node's;
//   - the web search tool (Node's side-search and enrichment hooks);
//   - the limit hold, which only Node narrates;
//   - a Codex client, whose limit failures finalizeRoutingError rewrites.
//
// So each reply Go gives comes from an upstream or the accounts' state, and
// none is a refusal of the request.
func Plan(in PlanInput) (*Target, error) {
	tool, err := claudeprep.DetectClientTool(in.Headers, in.Body)
	if err != nil {
		return nil, err
	}
	if tool == "codex" {
		return nil, declined("a Codex client (finalizeRoutingError rewrites its limit failures)")
	}
	hold := jsjson.Truthy(get(in.Settings, "limitHoldEnabled"))
	if in.KeyLimitHold != nil {
		hold = *in.KeyLimitHold
	}
	if hold {
		return nil, declined("the limit hold is on")
	}
	if needs, err := MayNeedCapability(in.Body); err != nil {
		return nil, err
	} else if needs {
		return nil, declined("a request that may need a model capability (image, PDF, audio, video, file or search)")
	}
	if tools := in.Body.Get("tools"); tools.IsArray() {
		for _, t := range tools.Items() {
			if t.IsObject() && t.Get("type").Is(tbl.WebSearchToolType) {
				return nil, declined("the web search tool (Node's search hooks)")
			}
		}
	}
	p := planner{cfg: in.Config, settings: in.Settings}
	members, err := in.Config.ComboModels(in.Model)
	if err != nil {
		return nil, err
	}
	if members == nil {
		if !strings.Contains(StripContextWindowSuffix(in.Model), "/") {
			return nil, declined("a bare model id that is no user combo (auto combos are Node's)")
		}
		return p.resolve(in.Model, nil)
	}
	return p.combo(in.Model, members, nil)
}

type planner struct {
	cfg      *Config
	settings accounts.Settings
}

func get(s accounts.Settings, key string) any {
	v, _ := s.Get(key)
	return v
}

// truthyOr is `a || b`.
func truthyOr(a, b any) any {
	if jsjson.Truthy(a) {
		return a
	}
	return b
}

// strategy is the combo's strategy: comboStrategies[key].fallbackStrategy,
// else the global comboStrategy, else fallback. Only fallback is served.
func (p planner) strategy(key string) error {
	var own any
	switch cs := truthyOr(get(p.settings, "comboStrategies"), nil).(type) {
	case nil:
	case *jsjson.Object:
		if entry, ok := cs.Get(key); ok {
			if o, ok := entry.(*jsjson.Object); ok {
				own, _ = o.Get("fallbackStrategy")
			}
		}
	default:
		return declined("a comboStrategies setting that isn't an object")
	}
	switch truthyOr(own, truthyOr(get(p.settings, "comboStrategy"), "fallback")) {
	case "fusion":
		return declined("combo %q uses the fusion strategy", key)
	case "round-robin":
		return declined("combo %q uses the round-robin strategy", key)
	}
	// Any other value runs handleComboChat's fallback order.
	return nil
}

func (p planner) combo(id string, members []string, path []string) (*Target, error) {
	key := ComboLookupName(id)
	for _, seen := range path {
		if seen == key {
			return nil, declined("combo %q is nested in itself (Node answers 400)", key)
		}
	}
	if len(path) >= tbl.MaxComboDepth {
		return nil, declined("combo %q is nested too deeply (Node answers 400)", key)
	}
	if err := p.strategy(key); err != nil {
		return nil, err
	}
	inner := append(append([]string(nil), path...), key)
	t := &Target{ID: id, Combo: key}
	for _, m := range members {
		mt, err := p.resolve(m, inner)
		if err != nil {
			return nil, err
		}
		t.Members = append(t.Members, mt)
	}
	return t, nil
}

// resolve is routeSingleModelChat's resolution of one id under path, the
// combos being expanded on the way to it.
func (p planner) resolve(id string, path []string) (*Target, error) {
	info, err := p.cfg.ModelInfo(id)
	if err != nil {
		return nil, err
	}
	if info.Provider == "" {
		nested, err := p.cfg.ComboModels(id)
		if err != nil {
			return nil, err
		}
		if nested == nil {
			return nil, declined("model %q resolves to no provider or combo (Node answers 400)", id)
		}
		return p.combo(id, nested, path)
	}
	if accounts.ModelIDProblem(info.Model) {
		return nil, declined("model id %q is refused by modelIdProblem (Node answers 400)", info.Model)
	}
	if !strings.HasPrefix(info.Provider, "openai-compatible-") {
		return nil, declined("provider %s is not an openai-compatible node", info.Provider)
	}
	return &Target{ID: id, Provider: info.Provider, Model: info.Model}, nil
}

// Leaf runs one provider model's account loop (accounts.RunModel).
type Leaf func(ctx context.Context, provider, model string) (accounts.Outcome, error)

// Env is what Run calls out to.
type Env struct {
	Leaf Leaf
	// Sleep waits ms or until ctx ends (the transient wait).
	Sleep func(ctx context.Context, ms float64) error
	// NowMs is the clock (unavailableResponse's Retry-After).
	NowMs func() float64
}

// Result is how the request ended: served by a leaf, the client gone, or
// the failure reply.
type Result struct {
	Success bool
	// Outcome is the serving leaf's.
	Outcome    accounts.Outcome
	ClientGone bool
	Response   accounts.Response
	// Message is the reply's error.message.
	Message string
}

// Run routes the request through t: a leaf's account loop, or
// handleComboChat's fallback over a combo's members.
func Run(ctx context.Context, t *Target, env Env) (Result, error) {
	if ctx.Err() != nil {
		return Result{ClientGone: true}, nil
	}
	if t.Combo != "" {
		return runCombo(ctx, t, env)
	}
	out, err := env.Leaf(ctx, t.Provider, t.Model)
	if err != nil {
		return Result{}, err
	}
	switch {
	case out.ClientGone:
		return Result{ClientGone: true}, nil
	case out.Success:
		return Result{Success: true, Outcome: out}, nil
	}
	return Result{Response: out.Reply.Response(env.NowMs()), Message: out.Reply.ClientMessage()}, nil
}

// transientStatuses are the statuses handleComboChat waits out a short
// cooldown for before the next member.
var transientStatuses = map[int]bool{502: true, 503: true, 504: true}

const maxTransientWaitMs = 5000

// runCombo is handleComboChat with the fallback strategy and no reorder
// (Plan declined anything that would reorder). Every member failure falls
// through: checkFallbackError always says to.
func runCombo(ctx context.Context, t *Target, env Env) (Result, error) {
	lastError, lastStatus := "", 0
	for _, m := range t.Members {
		r, err := Run(ctx, m, env)
		if err != nil || r.Success || r.ClientGone {
			return r, err
		}
		status, text := r.Response.Status, r.Message
		cooldown := accounts.CheckFallbackError(status, text, 0).CooldownMs
		if cooldown > 0 && cooldown <= maxTransientWaitMs && transientStatuses[status] {
			if err := env.Sleep(ctx, cooldown); err != nil {
				return Result{ClientGone: true}, nil
			}
		}
		lastError = text
		if lastError == "" {
			lastError = strconv.Itoa(status)
		}
		if lastStatus == 0 {
			lastStatus = status
		}
	}
	status := lastStatus
	if lastError != "" && accounts.ContainsFold(lastError, "no credentials") {
		status = 503
	}
	if status == 0 {
		status = 503
	}
	msg := lastError
	if msg == "" {
		msg = "All combo models unavailable"
	}
	return Result{Response: comboFailure(status, msg), Message: msg}, nil
}

// comboFailure is handleComboChat's all-failed reply (no member reply
// carries a retryAfter, so never unavailableResponse).
func comboFailure(status int, msg string) accounts.Response {
	inner := jsjson.NewObject()
	inner.Set("message", msg)
	body := jsjson.NewObject()
	body.Set("error", inner)
	return accounts.Response{Status: status, Header: []accounts.Header{{Name: "Content-Type", Value: "application/json"}}, Body: jsjson.Marshal(body)}
}
