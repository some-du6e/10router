package db

import (
	"fmt"
	"strings"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// ISOTime is Date#toISOString: UTC, milliseconds, a Z.
func ISOTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// localDateKey is usageRepo.js's getLocalDateKey: the local calendar date of
// an ISO timestamp, YYYY-MM-DD. new Date() of a string it can't read is an
// Invalid Date, whose fields are NaN.
func localDateKey(timestamp string) string {
	t, err := parseJSDate(timestamp)
	if err != nil {
		return "NaN-NaN-NaN"
	}
	return t.In(localZone()).Format("2006-01-02")
}

// localZone is the process's zone (TZ, else /etc/localtime), what Node's
// Date uses. Tests swap it rather than time.Local, which goroutines read.
var localZone = func() *time.Location { return time.Local }

// parseJSDate reads the timestamps Node writes (toISOString) and the other
// ISO forms Date.parse takes for them.
func parseJSDate(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.000Z07:00", "2006-01-02T15:04:05Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("not an ISO timestamp: %q", s)
}

// isJSSpace is JavaScript's WhiteSpace and LineTerminator, what String#trim removes.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func jsTrim(s string) string     { return strings.TrimFunc(s, isJSSpace) }
func jsTrimLeft(s string) string { return strings.TrimLeftFunc(s, isJSSpace) }

// jsString is String(v) for a parsed JSON value.
func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		return jsNumberString(t)
	case string:
		return t
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			// Array#join writes null and undefined as "".
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case *jsjson.Object:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// jsNumberString is String(n), which differs from JSON only for NaN and the infinities.
func jsNumberString(f float64) string {
	switch {
	case f != f:
		return "NaN"
	case f > 1.7976931348623157e308:
		return "Infinity"
	case f < -1.7976931348623157e308:
		return "-Infinity"
	}
	return string(jsjson.AppendNumber(nil, f))
}

// num is a parsed value as a number when it is one, else 0. Node's rows hold
// numbers where these are read; anything else is a row it didn't write.
func num(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

// firstTruthy is `a || b || ...` over an object's fields: the first truthy
// value, else nil.
func firstTruthy(o *jsjson.Object, keys ...string) any {
	for _, k := range keys {
		if v, ok := o.Get(k); ok && jsjson.Truthy(v) {
			return v
		}
	}
	return nil
}

// objectOrNew is `v || {}` for a value that should be an object; a value
// that is truthy but not an object (a row Node didn't write) becomes {} too.
func objectOrNew(v any) *jsjson.Object {
	if o, ok := v.(*jsjson.Object); ok && o != nil {
		return o
	}
	return jsjson.NewObject()
}
