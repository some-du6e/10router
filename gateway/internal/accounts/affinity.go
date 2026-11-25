package accounts

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"math/rand/v2"
	"strings"
	"sync"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
)

func defaultRandom() float64 { return rand.Float64() }

// WarmKeys is cacheAffinity.js's conversation → warm keys map: which keys
// served a conversation within their cache TTL, most recently used last, with
// the least recently used conversation dropped first.
type WarmKeys struct {
	mu    sync.Mutex
	order *list.List // of *warmEntry, least recent first
	byKey map[string]*list.Element
}

type warmEntry struct {
	key  string
	keys []warmKey // least recent first
}

type warmKey struct {
	connectionID string
	at, ttlMs    float64
}

// NewWarmKeys makes an empty map.
func NewWarmKeys() *WarmKeys {
	return &WarmKeys{order: list.New(), byKey: map[string]*list.Element{}}
}

// Get is getWarmKeys: the keys that served the conversation within their
// TTL, most recent last. Expired ones are dropped.
func (w *WarmKeys) Get(key string, now float64) []string {
	if key == "" {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	el, ok := w.byKey[key]
	if !ok {
		return nil
	}
	e := el.Value.(*warmEntry)
	kept := e.keys[:0]
	for _, k := range e.keys {
		if !(now-k.at > k.ttlMs) {
			kept = append(kept, k)
		}
	}
	e.keys = kept
	if len(e.keys) == 0 {
		w.order.Remove(el)
		delete(w.byKey, key)
		return nil
	}
	out := make([]string, len(e.keys))
	for i, k := range e.keys {
		out[i] = k.connectionID
	}
	return out
}

// Remember is rememberWarmKey: this key just served the conversation.
func (w *WarmKeys) Remember(key, connectionID string, ttlMs, now float64) {
	if key == "" || connectionID == "" || !(ttlMs > 0) {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	var e *warmEntry
	if el, ok := w.byKey[key]; ok {
		e = el.Value.(*warmEntry)
		w.order.Remove(el)
		delete(w.byKey, key)
	} else {
		e = &warmEntry{key: key}
	}
	kept := e.keys[:0]
	for _, k := range e.keys {
		if k.connectionID != connectionID {
			kept = append(kept, k)
		}
	}
	e.keys = append(kept, warmKey{connectionID: connectionID, at: now, ttlMs: ttlMs})
	for len(e.keys) > tbl.CacheAffinity.MaxWarmKeys {
		e.keys = e.keys[1:]
	}
	for w.order.Len() >= tbl.CacheAffinity.MaxEntries {
		oldest := w.order.Front()
		w.order.Remove(oldest)
		delete(w.byKey, oldest.Value.(*warmEntry).key)
	}
	w.byKey[key] = w.order.PushBack(e)
}

// Len is conversationCount.
func (w *WarmKeys) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.order.Len()
}

const (
	cacheControl = "cache_control"
	longTTL      = "1h"
)

// cacheMarkers are the cache_control values on the request, system, tools
// and message content.
func cacheMarkers(body *claudeprep.Value) []*claudeprep.Value {
	var markers []*claudeprep.Value
	take := func(part *claudeprep.Value) {
		if part.IsObject() || part.IsArray() {
			if m := part.Get(cacheControl); m.Truthy() {
				markers = append(markers, m)
			}
		}
	}
	takeAll := func(list *claudeprep.Value) {
		if list.IsArray() {
			for _, p := range list.Items() {
				take(p)
			}
		}
	}
	take(body)
	takeAll(body.Get("system"))
	takeAll(body.Get("tools"))
	if msgs := body.Get("messages"); msgs.IsArray() {
		for _, m := range msgs.Items() {
			take(m)
			if m.IsObject() || m.IsArray() {
				takeAll(m.Get("content"))
			}
		}
	}
	return markers
}

// RequestUsesPromptCache is requestUsesPromptCache.
func RequestUsesPromptCache(body *claudeprep.Value) bool {
	if !body.IsObject() {
		return false
	}
	if k := body.Get("prompt_cache_key"); k.IsString() && k.Str() != "" {
		return true
	}
	return len(cacheMarkers(body)) > 0
}

// CacheTTLMs is cacheTtlMs: 1h when a marker asks for it.
func CacheTTLMs(body *claudeprep.Value) float64 {
	for _, m := range cacheMarkers(body) {
		if (m.IsObject() || m.IsArray()) && m.Get("ttl").Is(longTTL) {
			return math.Max(tbl.CacheAffinity.LongTTLMs, tbl.CacheAffinity.TTLMs)
		}
	}
	return tbl.CacheAffinity.TTLMs
}

// stableCopy is what JSON.stringify's `stable` replacer writes: cache_control
// keys dropped and every string through stripAnthropicBillingHeader.
func stableCopy(v *claudeprep.Value) *claudeprep.Value {
	switch {
	case v.IsString():
		return claudeprep.String(billingHeaderRe.ReplaceAllLiteralString(v.Str(), ""))
	case v.IsArray():
		items := v.Items()
		out := make([]*claudeprep.Value, len(items))
		for i, it := range items {
			out[i] = stableCopy(it)
		}
		return claudeprep.Array(out...)
	case v.IsObject():
		o := claudeprep.Object()
		v.Each(func(key string, val *claudeprep.Value) {
			if key != cacheControl {
				o.Set(key, stableCopy(val))
			}
		})
		return o
	}
	return v
}

var leadingRoles = map[string]bool{"system": true, "developer": true}

// conversationStart: the system prompt, instructions and the first message,
// without cache markers or Claude Code's per-request billing header.
func conversationStart(body *claudeprep.Value) ([]byte, bool) {
	items := body.Get("messages")
	if !items.IsArray() {
		items = body.Get("input")
	}
	var lead []*claudeprep.Value
	if items.IsArray() {
		for _, it := range items.Items() {
			lead = append(lead, it)
			role := claudeprep.Undefined()
			if it.IsObject() || it.IsArray() {
				role = it.Get("role")
			}
			if !role.IsString() || !leadingRoles[role.Str()] {
				break
			}
		}
	}
	system, instructions := body.Get("system"), body.Get("instructions")
	if len(lead) == 0 && system.IsNullish() && instructions.IsNullish() {
		return nil, false
	}
	orNull := func(v *claudeprep.Value) *claudeprep.Value {
		if v.IsNullish() {
			return claudeprep.Null()
		}
		return v
	}
	start := claudeprep.Array(orNull(system), orNull(instructions), claudeprep.Array(lead...))
	return claudeprep.Marshal(stableCopy(start)), true
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// CacheAffinityKey is cacheAffinityKey: the conversation on one provider
// model, or "" when the request gets no affinity. headers are the client's,
// lowercase names (Object.fromEntries(request.headers)); tenant is its key.
// A session id Node would read its own way is a decline.
func CacheAffinityKey(provider, model string, body *claudeprep.Value, headers map[string]string, tenant string) (string, error) {
	if !(tbl.CacheAffinity.TTLMs > 0) || provider == "" || model == "" || affinityProvider[provider] {
		return "", nil
	}
	if !RequestUsesPromptCache(body) {
		return "", nil
	}
	start, ok := conversationStart(body)
	if !ok {
		return "", nil
	}
	session, err := clientSessionID(headers, body)
	if err != nil {
		return "", err
	}
	tenantPart := ""
	if tenant != "" {
		tenantPart = sha256Hex([]byte(tenant))
	}
	joined := strings.Join([]string{provider, model, tenantPart, session, sha256Hex(start)}, "\x00")
	return sha256Hex([]byte(joined))[:32], nil
}

// claudeCodeSessionHeader is sessionManager.js's CLAUDE_CODE_SESSION_HEADER.
const claudeCodeSessionHeader = "x-claude-code-session-id"

// normalizeSessionID is sessionManager.js's normalizeSessionId.
func normalizeSessionID(v *claudeprep.Value) string {
	if !v.IsString() {
		return ""
	}
	t := jsTrim(v.Str())
	if t == "" || utf16Len(t) > 256 {
		return ""
	}
	return t
}

func headerSession(headers map[string]string, key string) string {
	v, ok := headers[key]
	if !ok {
		v, ok = headers[strings.ToLower(key)]
	}
	if !ok {
		return ""
	}
	return normalizeSessionID(claudeprep.String(v))
}

// clientSessionID is extractClientSessionId with strict (no generated ids).
func clientSessionID(headers map[string]string, body *claudeprep.Value) (string, error) {
	claude := ""
	if meta := body.Get("metadata"); meta.IsObject() || meta.IsArray() {
		if uid := meta.Get("user_id"); uid.IsString() && uid.Str() != "" {
			s := uid.Str()
			if m := claudeSessionRe.FindStringSubmatch(s); m != nil {
				claude = m[1]
			} else if s[0] == '{' {
				parsed, err := claudeprep.Parse([]byte(s))
				switch {
				case err != nil && claudeprep.IsDecline(err):
					return "", declined("a metadata.user_id Node's JSON.parse would read its own way")
				case err == nil && (parsed.IsObject() || parsed.IsArray()):
					claude = normalizeSessionID(parsed.Get("session_id"))
				}
			}
		}
	}
	if claude == "" {
		claude = headerSession(headers, claudeCodeSessionHeader)
	}
	if claude != "" {
		return "claude:" + claude, nil
	}
	if req := body.Get("request"); !req.IsNullish() {
		return "", declined("an Antigravity-shaped request envelope")
	}
	if rid := body.Get("requestId"); !rid.IsNullish() {
		return "", declined("an Antigravity-shaped requestId")
	}
	for _, key := range tbl.SessionHeaderKeys {
		if v := headerSession(headers, key); v != "" {
			return v, nil
		}
	}
	for _, field := range []string{"prompt_cache_key", "session_id", "conversation_id"} {
		if v := normalizeSessionID(body.Get(field)); v != "" {
			return v, nil
		}
	}
	return "", nil
}

// EstimatePromptTokens is estimatePromptTokens: about 4 characters a token,
// inline images and files not counted.
func EstimatePromptTokens(body *claudeprep.Value) float64 {
	return math.Ceil(float64(textChars(body, 0, "")) / 4)
}

func textChars(v *claudeprep.Value, depth int, parentKey string) int {
	if v.IsString() {
		if dataURIRe.MatchString(v.Str()) {
			return 0
		}
		return utf16Len(v.Str())
	}
	if !(v.IsObject() || v.IsArray()) || depth > 64 {
		return 0
	}
	n := 0
	if v.IsArray() {
		for _, it := range v.Items() {
			n += textChars(it, depth+1, "")
		}
		return n
	}
	binary := v.Get("type").Is(tbl.InlineMedia.Base64SourceType) || parentKey == "input_audio"
	for _, k := range tbl.InlineMedia.MimeTypeKeys {
		if v.Has(k) {
			binary = true
		}
	}
	v.Each(func(k string, val *claudeprep.Value) {
		if binary && k == tbl.InlineMedia.DataKey {
			return
		}
		n += utf16Len(k) + textChars(val, depth+1, k)
	})
	return n
}

// WarmWaitBudget is warmWaitBudget: how much longer this request may wait
// for a warm key, 0 when it may not (a small prompt rebuilds cheaply).
func WarmWaitBudget(waitedMs float64, promptTokens func() float64) float64 {
	left := tbl.CacheAffinity.MaxWaitMs - waitedMs
	if !(left > 0) {
		return 0
	}
	if promptTokens() >= tbl.CacheAffinity.MinPromptTokens {
		return left
	}
	return 0
}

// warmJitterMs is warmJitterMs for a random number in [0, 1).
func warmJitterMs(random float64) float64 {
	return math.Floor(math.Min(math.Max(random, 0), 0.999) * (tbl.CacheAffinity.JitterMs + 1))
}

// warmRetryAt is warmRetryAt: just after the lock (slack and jitter), no
// later than budgetMs from now; ok is false when even that doesn't fit.
func warmRetryAt(lockEndMs, budgetMs, jitterMs, now float64) (float64, bool) {
	earliest := math.Max(lockEndMs, now) + tbl.CacheAffinity.LockSlackMs
	if earliest-now > budgetMs {
		return 0, false
	}
	return math.Min(earliest+jitterMs, now+budgetMs), true
}

// WarmRetryAt is warmRetryAt with no jitter, for the account loop's "a warm
// key just rate-limited stays in play" check.
func WarmRetryAt(lockEndMs, budgetMs, now float64) bool {
	_, ok := warmRetryAt(lockEndMs, budgetMs, 0, now)
	return ok
}
