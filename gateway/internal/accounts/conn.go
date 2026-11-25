package accounts

import (
	"strings"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
)

const pkg = "accounts"

func declined(format string, args ...any) error { return decline.New(pkg, format, args...) }

// conn is a connection as auth.js reads it: the columns and the data fields
// together (rowToConn), with the date fields Node compares already parsed.
type conn struct {
	*db.Connection
}

func (c conn) get(key string) any {
	v, _ := c.Data.Get(key)
	return v
}

// num is a numeric field (Node compares them with ===, so only a number counts).
func (c conn) num(key string) (float64, bool) {
	f, ok := c.get(key).(float64)
	return f, ok
}

// isoLayout is Date#toISOString's: what Node writes in every date field.
const isoLayout = "2006-01-02T15:04:05.000Z"

// parseISO reads a date Node wrote; ok is false for anything else.
func parseISO(s string) (float64, bool) {
	t, err := time.Parse(isoLayout, s)
	if err != nil || t.Year() < 1970 {
		return 0, false
	}
	return float64(t.UnixMilli()), true
}

// dateMs is `new Date(v).getTime()` for a field that is falsy (0 here) or a
// date Node wrote. checkDates has declined every other value beforehand.
func dateMs(v any) float64 {
	s, ok := v.(string)
	if !ok || s == "" {
		return 0
	}
	ms, _ := parseISO(s)
	return ms
}

// dateFieldPrefixes are the fields selection reads as dates.
var dateFieldPrefixes = []string{ModelLockPrefix, providerResetPrefix}

// checkDates declines a connection whose date fields Node's Date parser
// would read its own way: anything but null, a falsy value or Node's own
// ISO form. JavaScript's parser takes many forms Go's doesn't.
func (c conn) checkDates() error {
	// Counters and codes Node does arithmetic and comparisons on: a string
	// there would be concatenated or coerced.
	for _, key := range []string{"errorCode", "backoffLevel", "consecutiveUseCount"} {
		if v := c.get(key); v != nil {
			if _, ok := v.(float64); !ok {
				return declined("connection %s has a %s that isn't a number", c.ID, key)
			}
		}
	}
	if v := c.get("lastError"); v != nil {
		if _, ok := v.(string); !ok {
			return declined("connection %s has a lastError that isn't a string", c.ID)
		}
	}
	for _, m := range c.Data.Members() {
		isDate := m.Key == "lastUsedAt"
		for _, p := range dateFieldPrefixes {
			isDate = isDate || strings.HasPrefix(m.Key, p)
		}
		if !isDate || !jsjson.Truthy(m.Value) {
			continue
		}
		s, ok := m.Value.(string)
		if !ok {
			return declined("connection %s has a %s that isn't a date string", c.ID, m.Key)
		}
		if _, ok := parseISO(s); !ok {
			return declined("connection %s has a %s Node's Date parser would read its own way", c.ID, m.Key)
		}
	}
	return nil
}

// hasDemotion: a demotion record on any model. Demotions and the spread of
// dead keys go by evidence Node keeps in memory, so they are Node's.
func (c conn) hasDemotion() bool {
	for _, m := range c.Data.Members() {
		if strings.HasPrefix(m.Key, db.AuthDemotePrefix) && jsjson.Truthy(m.Value) {
			return true
		}
	}
	return false
}

// modelLockUntil is getModelLockUntil: the later of the model's own lock and
// the account-wide one, 0 for neither.
func (c conn) modelLockUntil(model string) float64 {
	return max(0, dateMs(c.get(ModelLockKey(model))), dateMs(c.get(ModelLockAll)))
}

func (c conn) modelLockActive(model string, now float64) bool {
	return c.modelLockUntil(model) > now
}

// ownLockEnd is ownLockEndMs: when the model's own lock ends.
func (c conn) ownLockEnd(model string) float64 { return dateMs(c.get(ModelLockKey(model))) }

// limitLocked is isLimitLocked: the lock that ends last is a limit's.
func (c conn) limitLocked(model string, now float64) bool {
	own, all := c.ownLockEnd(model), dateMs(c.get(ModelLockAll))
	sc, until := scope(model), own
	if all > own {
		sc, until = "__all", all
	}
	return until > now && c.get(modelLimitPrefix+sc) == true
}

// priority is `c.priority || 999`.
func (c conn) priority() float64 {
	switch p := c.Priority.(type) {
	case int64:
		if p != 0 {
			return float64(p)
		}
	case float64:
		if p != 0 {
			return p
		}
	}
	return 999
}

// displayName is `displayName || name || email || id`.
func (c conn) displayName() string {
	if s, ok := c.get("displayName").(string); ok && s != "" {
		return s
	}
	if c.Name != nil && *c.Name != "" {
		return *c.Name
	}
	if c.Email != nil && *c.Email != "" {
		return *c.Email
	}
	return c.ID
}

// testStatus, lastError and errorCode as the clear path reads them.
func (c conn) truthy(key string) bool { return jsjson.Truthy(c.get(key)) }
