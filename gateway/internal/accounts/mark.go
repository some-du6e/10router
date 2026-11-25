package accounts

import (
	"context"
	"math"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// AuthRefusal: a 401 or 403. Node weighs it as dead-key evidence against the
// other keys' recent successes, which live in its memory, so the gateway
// hands such a failure to Node while no byte has gone to the client. After
// that it can only lock the key the plain way (MarkUnavailable), without the
// evidence: dead keys are then turned off more slowly.
func AuthRefusal(status int) bool { return status == 401 || status == 403 }

// Marked is markAccountUnavailable's result.
type Marked struct {
	ShouldFallback    bool
	CooldownMs        float64
	ProviderResetAtMs float64 // the reset the error named (0: none)
}

// MarkUnavailable is markAccountUnavailable without the auth evidence (see
// AuthRefusal): the model's lock with ERROR_RULES' cooldown or backoff, its
// limit and header-timeout flags, the provider's reset, and the error. A
// limit that lands inside the model's own lock keeps that lock; a header
// timeout never shortens a longer one. resetsAtMs is an exact reset the
// provider named (0: none).
func (a *Accounts) MarkUnavailable(ctx context.Context, connectionID, provider string, status int, errorText, model string, resetsAtMs float64) (Marked, error) {
	rows, err := a.Store.ListConnections(ctx, provider, nil)
	if err != nil {
		return Marked{}, err
	}
	var c *conn
	for _, r := range rows {
		if r.ID == connectionID {
			c = &conn{r}
			break
		}
	}
	if c != nil {
		if err := c.checkDates(); err != nil {
			return Marked{}, err
		}
	}
	now := a.nowMs()
	backoff := 0.0
	if c != nil {
		backoff, _ = c.num("backoffLevel")
	}
	var cooldown float64
	newBackoff, hasNew := 0.0, false
	inOwnLock, keptLock := false, false
	ownLockEnd := func() float64 {
		if c == nil {
			return 0
		}
		return c.ownLockEnd(model)
	}
	if resetsAtMs > now {
		cooldown = math.Min(resetsAtMs-now, tbl.MaxRateLimitCooldownMs)
		newBackoff, hasNew = 0, true
	} else {
		f := CheckFallbackError(status, errorText, int(backoff))
		cooldown = f.CooldownMs
		if f.HasBackoffLevel {
			newBackoff, hasNew = float64(f.NewBackoffLevel), true
		}
		// A limit landing while the model is locked came from a request sent
		// before the lock: the backoff escalates once, the lock is kept.
		if hasNew && c != nil && c.modelLockActive(model, now) {
			newBackoff = backoff
			own := ownLockEnd()
			inOwnLock = own > now
			cooldown = math.Max(own-now, QuotaCooldown(int(backoff)))
		}
		if ownMs := ownLockEnd() - now; IsHeadersTimeout(status, errorText) && ownMs > cooldown {
			keptLock, inOwnLock = true, true
			cooldown = ownMs
		}
	}

	lockKey := ModelLockKey(model)
	sc := scope(model)
	limitKey, noHeadersKey := modelLimitPrefix+sc, noHeadersPrefix+sc
	var set []jsjson.Member
	if keptLock {
		set = append(set, jsjson.Member{Key: lockKey, Value: c.get(lockKey)})
	} else {
		set = append(set, jsjson.Member{Key: lockKey, Value: isoMs(now + cooldown)})
	}
	limitFlag := (inOwnLock && c.get(limitKey) == true) || IsLimitError(status, errorText)
	set = append(set, jsjson.Member{Key: limitKey, Value: limitFlag})
	timeout := IsHeadersTimeout(status, errorText)
	if timeout || (c != nil && c.truthy(noHeadersKey)) {
		flag := false
		if keptLock {
			flag = c.get(noHeadersKey) == true
		} else {
			flag = timeout && !limitFlag
		}
		var v any
		if flag {
			v = true
		}
		set = append(set, jsjson.Member{Key: noHeadersKey, Value: v})
	}
	if !inOwnLock {
		var v any
		if resetsAtMs > now {
			v = isoMs(resetsAtMs)
		}
		set = append(set, jsjson.Member{Key: providerResetPrefix + sc, Value: v})
	}
	set = append(set, jsjson.Member{Key: "testStatus", Value: "unavailable"})
	if !keptLock {
		set = append(set,
			jsjson.Member{Key: "lastError", Value: utf16Prefix(errorText, 100)},
			jsjson.Member{Key: "errorCode", Value: float64(status)},
			jsjson.Member{Key: "lastErrorAt", Value: isoMs(now)},
		)
	}
	level := backoff
	if hasNew {
		level = newBackoff
	}
	set = append(set, jsjson.Member{Key: "backoffLevel", Value: level})
	if _, err := a.Store.UpdateConnection(ctx, connectionID, db.ConnectionUpdate{Set: set}); err != nil {
		return Marked{}, err
	}
	out := Marked{ShouldFallback: true, CooldownMs: cooldown}
	if resetsAtMs > 0 {
		out.ProviderResetAtMs = resetsAtMs
	}
	return out, nil
}

// authFailCleared is auth.js's AUTH_FAIL_CLEARED, in its order.
var authFailCleared = []string{
	"authFailCount", "authFailFirstAt", "authFailLastAt", "authFailModels", "authFailAll401",
	"authFailSameUpstream", "authFailRunCount", "authFailRunStartAt", "authFailBursts",
}

// ClearError is clearAccountError: picked is the connection as selection
// read it. The model's lock and the account-wide one go, with any expired
// lock and the flags beside them; the error goes once no lock is left; the
// auth streak goes on any success; and the key's first success in this
// process notes authDemoteOkAt.
func (a *Accounts) ClearError(ctx context.Context, picked *db.Connection, model string) error {
	c := conn{picked}
	now := a.nowMs()
	var allLockKeys []string
	for _, m := range c.Data.Members() {
		k := m.Key
		if !strings.HasPrefix(k, ModelLockPrefix) {
			continue
		}
		rest := k[len(ModelLockPrefix):]
		if jsjson.Truthy(m.Value) || c.truthy(providerResetPrefix+rest) || c.truthy(modelLimitPrefix+rest) || c.truthy(noHeadersPrefix+rest) {
			allLockKeys = append(allLockKeys, k)
		}
	}
	a.servedMu.Lock()
	firstThisBoot := !a.served[c.ID]
	a.served[c.ID] = true
	a.servedMu.Unlock()
	noteServed := firstThisBoot
	if !c.truthy("testStatus") && !c.truthy("lastError") && !c.truthy("errorCode") && len(allLockKeys) == 0 && !c.truthy("authFailCount") && !noteServed {
		return nil
	}
	clear := map[string]bool{}
	var keysToClear []string
	for _, k := range allLockKeys {
		expiry := c.get(k)
		if (model != "" && k == ModelLockPrefix+model) || (model != "" && k == ModelLockAll) || !jsjson.Truthy(expiry) || dateMs(expiry) <= now {
			keysToClear = append(keysToClear, k)
			clear[k] = true
		}
	}
	if len(keysToClear) == 0 && c.get("testStatus") != "unavailable" && !c.truthy("lastError") && !c.truthy("errorCode") && !c.truthy("authFailCount") && !noteServed {
		return nil
	}
	remaining := 0
	for _, k := range allLockKeys {
		if !clear[k] && jsjson.Truthy(c.get(k)) && dateMs(c.get(k)) > now {
			remaining++
		}
	}
	obj := jsjson.NewObject()
	for _, k := range keysToClear {
		obj.Set(k, nil)
	}
	if c.truthy("authFailCount") {
		for _, k := range authFailCleared {
			obj.Set(k, nil)
		}
	}
	for _, k := range keysToClear {
		rest := k[len(ModelLockPrefix):]
		obj.Set(providerResetPrefix+rest, nil)
		obj.Set(modelLimitPrefix+rest, nil)
		obj.Set(noHeadersPrefix+rest, nil)
	}
	if remaining == 0 {
		obj.Set("testStatus", "active")
		obj.Set("lastError", nil)
		obj.Set("errorCode", nil)
		obj.Set("lastErrorAt", nil)
		obj.Set("backoffLevel", 0.0)
	}
	if obj.Len() == 0 && !noteServed {
		return nil
	}
	_, err := a.Store.UpdateConnection(ctx, c.ID, db.ConnectionUpdate{Set: obj.Members(), LiftDemote: model, NoteServed: noteServed})
	return err
}

// utf16Prefix is String#slice(0, n): the first n UTF-16 code units. A
// surrogate pair cut in two leaves its high half, as WTF-8 (jsjson writes it
// as \ud83d, as JSON.stringify does).
func utf16Prefix(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			if units < n && w == 2 {
				// The high surrogate, encoded the way UTF-8 would encode U+D800..U+DBFF.
				hi := 0xD800 + ((r - 0x10000) >> 10)
				return s[:i] + string([]byte{byte(0xE0 | hi>>12), byte(0x80 | (hi>>6)&0x3F), byte(0x80 | hi&0x3F)})
			}
			return s[:i]
		}
		units += w
	}
	return s
}
