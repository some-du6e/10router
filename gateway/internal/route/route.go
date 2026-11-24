// Package route is the native /v1/messages entry (docs/GO_GATEWAY.md, phase
// 2): which request targets reach Node's src/app/api/v1/messages/route.js
// (the next.config.mjs rewrites), the body as chat.ts reads it
// (src/sse/utils/requestBody.js), the [1m] marker strip, and the Claude Code
// bypass for warmup, title and count requests (open-sse/utils/bypassHandler.js).
//
// It also gates the shape. Native serves only bodies shaped like the
// production hot path: a JSON object with a model, `stream: true` and a
// non-empty messages array of objects. Everything else, every body Node
// would refuse with a 400 and every request Node would answer itself
// without calling an upstream (the bypass), is a *DeclineError, and the
// request goes to Node with its bytes unchanged.
package route

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/combo"
)

// DeclineError: the request goes to Node.
type DeclineError struct{ Reason string }

func (e *DeclineError) Error() string { return "route: proxy to Node: " + e.Reason }

func decline(format string, args ...any) error {
	return &DeclineError{fmt.Sprintf(format, args...)}
}

// Paths are the request paths that reach /api/v1/messages: the route itself
// and the two rewrites in next.config.mjs (/v1/:path* and /v1/v1/:path*).
// Any other spelling (a trailing slash, which Next redirects, a doubled
// slash, an escape) is Node's.
var Paths = []string{"/v1/messages", "/v1/v1/messages", "/api/v1/messages"}

// Match reports whether a request is one native serves: POST to one of
// Paths, the request target in origin form (a path and maybe a query).
func Match(method, requestURI string) bool {
	if method != http.MethodPost || !strings.HasPrefix(requestURI, "/") {
		return false
	}
	path := requestURI
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	for _, p := range Paths {
		if path == p {
			return true
		}
	}
	return false
}

// Request is the body as chat.ts reads it, for the routing that follows.
type Request struct {
	// Body is the parsed body. Routing reads it; claudeprep.Prepare parses the
	// bytes again for each attempt and edits its own copy.
	Body *claudeprep.Value
	// Model is chat.ts's modelStr: body.model with the [1m] marker off.
	Model string
}

// Inspect parses the body as readJsonObject does and checks its shape.
// userAgent is the client's User-Agent ("" when absent), ccFilterNaming the
// setting of that name.
func Inspect(raw []byte, userAgent string, ccFilterNaming bool) (*Request, error) {
	body, err := claudeprep.Parse(raw)
	if err != nil {
		if claudeprep.IsDecline(err) {
			return nil, &DeclineError{err.Error()}
		}
		return nil, decline("a body that isn't JSON (Node answers 400)")
	}
	if !body.IsObject() {
		return nil, decline("a body that isn't an object (Node answers 400)")
	}
	m := body.Get("model")
	if !m.IsString() {
		return nil, decline("model is not a string (Node answers 400)")
	}
	if err := asciiModel(m.Str()); err != nil {
		return nil, err
	}
	model, _ := combo.StripContextMarker(m.Str())
	if strings.Trim(model, " \t\n\v\f\r") == "" {
		return nil, decline("no model (Node answers 400)")
	}
	// The hot path's shape: a stream, and a conversation.
	if s := body.Get("stream"); s.Kind() != claudeprep.KindBool || !s.Truthy() {
		return nil, decline("not stream: true")
	}
	msgs := body.Get("messages")
	if !msgs.IsArray() || msgs.Len() == 0 {
		return nil, decline("messages is not a non-empty array")
	}
	for _, msg := range msgs.Items() {
		if !msg.IsObject() {
			return nil, decline("a message that is not an object")
		}
	}
	bypassed, err := Bypassed(body, userAgent, ccFilterNaming)
	if err != nil {
		return nil, err
	}
	if bypassed {
		return nil, decline("a Claude Code warmup, title or count request (Node answers it itself)")
	}
	return &Request{Body: body, Model: model}, nil
}

// asciiModel: the model id is matched against combos, aliases and allowlists
// with JavaScript's trim and case rules, which follow Unicode; only
// printable ASCII is matched the same way here.
func asciiModel(s string) error {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return decline("a model id that is not printable ASCII")
		}
	}
	return nil
}

// skipPatterns is runtimeConfig.js's SKIP_PATTERNS.
var skipPatterns = []string{"Please write a 5-10 word title for the following conversation:"}

// Bypassed is handleBypassRequest's decision: would Node answer this request
// with its canned reply? An input on which Node would throw is declined.
func Bypassed(body *claudeprep.Value, userAgent string, ccFilterNaming bool) (bool, error) {
	if !strings.Contains(userAgent, "claude-cli") {
		return false, nil
	}
	msgs := body.Get("messages")
	if !msgs.IsArray() || msgs.Len() == 0 {
		return false, nil
	}
	items := msgs.Items()
	// Pattern 1: title extraction (the last message is an assistant "{").
	last := items[len(items)-1]
	if last.IsObject() && last.Get("role").Is("assistant") {
		// content?.[0]?.text: an array's first item, or an object's "0" key (a
		// string's first character has no text).
		c := last.Get("content")
		first := claudeprep.Undefined()
		switch {
		case c.IsArray() && c.Len() > 0:
			first = c.Items()[0]
		case c.IsObject():
			first = c.Get("0")
		}
		if first.IsObject() && first.Get("text").Is("{") {
			return true, nil
		}
	}
	// Pattern 2: warmup.
	text, err := getText(firstContent(items))
	if err != nil {
		return false, err
	}
	if text == "Warmup" {
		return true, nil
	}
	// Pattern 3: count.
	if len(items) == 1 && items[0].IsObject() && items[0].Get("role").Is("user") && text == "count" {
		return true, nil
	}
	// Pattern 4: skip patterns, over every user message's text.
	var parts []string
	for _, m := range items {
		if m.IsNullish() {
			return false, decline("a null message (Node throws reading its role)")
		}
		if m.Get("role").Is("user") {
			t, err := getText(m.Get("content"))
			if err != nil {
				return false, err
			}
			parts = append(parts, t)
		}
	}
	userText := strings.Join(parts, " ")
	for _, p := range skipPatterns {
		if strings.Contains(userText, p) {
			return true, nil
		}
	}
	// Pattern 5: Claude Code's naming request.
	if ccFilterNaming {
		var fromMessages, fromBody string
		for _, m := range items {
			if m.Get("role").Is("system") {
				if fromMessages, err = getText(m.Get("content")); err != nil {
					return false, err
				}
				break
			}
		}
		// Worked out whether or not a system message had text, so its throws count.
		sys := body.Get("system")
		switch {
		case sys.IsArray():
			if fromBody, err = textOf(sys.Items()); err != nil {
				return false, err
			}
		case sys.IsString():
			fromBody = sys.Str()
		}
		system := fromMessages
		if system == "" {
			system = fromBody
		}
		if strings.Contains(system, "isNewTopic") {
			return true, nil
		}
	}
	return false, nil
}

// firstContent is messages[0]?.content.
func firstContent(items []*claudeprep.Value) *claudeprep.Value {
	if items[0].IsNullish() {
		return claudeprep.Undefined()
	}
	return items[0].Get("content")
}

// getText is bypassHandler.js's getText.
func getText(content *claudeprep.Value) (string, error) {
	switch {
	case content.IsString():
		return content.Str(), nil
	case content.IsArray():
		return textOf(content.Items())
	}
	return "", nil
}

// textOf is blocks.filter(c => c.type === "text").map(c => c.text).join(" ").
// Node throws on a null block; a text that isn't a string is declined rather
// than converted the way Array#join converts it.
func textOf(blocks []*claudeprep.Value) (string, error) {
	var parts []string
	for _, b := range blocks {
		if b.IsNullish() {
			return "", decline("a null content block (Node throws reading its type)")
		}
		if !b.Get("type").Is("text") {
			continue
		}
		t := b.Get("text")
		switch {
		case t.IsString():
			parts = append(parts, t.Str())
		case t.IsNullish():
			parts = append(parts, "")
		default:
			return "", decline("a text block whose text is not a string")
		}
	}
	return strings.Join(parts, " "), nil
}
