// Package shadow is GATEWAY_SHADOW=1 (CI only): Node serves every client,
// and for each /v1/messages the gateway works out what its native route
// would do (internal/native: the checks, the plan, the preflight) and, for
// each upstream request Node sends, prepares the same attempt and compares
// URL, headers in order, and body bytes. It never sends upstream and never
// writes the database.
//
// Node learns which request a send belongs to from IDHeader, which only a
// request the gateway proved to Node carries (custom-server.js), and reports
// each send to ReportPath on the gateway's own port with the peer token.
package shadow

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
	"github.com/some-du6e/10router/gateway/internal/native"
)

// ReportPath is where Node reports each upstream send of a shadowed request.
const ReportPath = "/_gateway/shadow"

// IDHeader carries a shadowed request's id to Node. The gateway removes any
// the client sent.
const IDHeader = "X-9r-Shadow-Id"

// TokenHeader proves a report comes from the Node the gateway started: the
// peer token.
const TokenHeader = "X-9r-Shadow-Token"

const (
	defaultMaxBody = 64 << 20
	// maxReport bounds a report: the upstream body, base64, and headers.
	maxReport = 96 << 20
	// maxPending bounds the requests awaiting reports.
	maxPending = 4096
	// defaultGrace is how long after its response ends a request waits for
	// Node's last reports before it is scored.
	defaultGrace = 2 * time.Second
	maxReasons   = 100
	maxDiffs     = 20
)

// Shadow is the compare's state.
type Shadow struct {
	// Native is the native route, or nil and why it is off.
	Native func() (*native.Native, string)
	Token  string
	Logger *log.Logger
	// MaxBody bounds the request body the shadow reads (64 MB when 0); a
	// larger one is relayed as is and counted declined.
	MaxBody int64
	// Grace: see defaultGrace (when 0).
	Grace time.Duration

	mu      sync.Mutex
	pending map[string]*record
	stats   Stats
}

type record struct {
	n      *native.Native
	plan   *native.Plan
	sends  int
	scored bool
}

// Stats are the compare's counters.
type Stats struct {
	// Requests is every /v1/messages seen; Planned the ones the native route
	// would serve, Declined the others (by reason in Reasons).
	Requests, Planned, Declined int
	// Sends is every send Node reported. Matched: one Go prepared byte for
	// byte. Differed: one of a planned request Go would have sent otherwise.
	// Unplanned: a send of a request Go declined (Node's to serve). Unknown:
	// a report naming no request the shadow holds.
	Sends, Matched, Differed, Unplanned, Unknown int
	// NoSend: a planned request Node answered without sending anything,
	// where Go would have sent.
	NoSend int
	// Errors: a database read or a bad report.
	Errors  int
	Reasons map[string]int
	// Diffs are the latest differences, newest last.
	Diffs []string
}

func (s *Shadow) logf(format string, args ...any) {
	if s.Logger != nil {
		s.Logger.Printf("[Gateway] shadow: "+format, args...)
	}
}

// Snapshot is a copy of the counters.
func (s *Shadow) Snapshot() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.stats
	out.Reasons = make(map[string]int, len(s.stats.Reasons))
	for k, v := range s.stats.Reasons {
		out.Reasons[k] = v
	}
	out.Diffs = append([]string(nil), s.stats.Diffs...)
	return out
}

func (s *Shadow) declined(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stats.Declined++
	s.reasonLocked(reason)
}

func (s *Shadow) reasonLocked(reason string) {
	if s.stats.Reasons == nil {
		s.stats.Reasons = map[string]int{}
	}
	if _, ok := s.stats.Reasons[reason]; !ok && len(s.stats.Reasons) >= maxReasons {
		reason = "(other reasons)"
	}
	s.stats.Reasons[reason]++
}

func (s *Shadow) diffLocked(d string) {
	s.stats.Diffs = append(s.stats.Diffs, d)
	if len(s.stats.Diffs) > maxDiffs {
		s.stats.Diffs = s.stats.Diffs[len(s.stats.Diffs)-maxDiffs:]
	}
}

func randomID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

type readCloser struct {
	io.Reader
	io.Closer
}

// Observe is called for each /v1/messages before it is relayed: it reads
// the body, plans the request as the native route would, and tags it for
// Node's reports. peerIP is the client's connection address. finish must be
// called when the relay ends.
func (s *Shadow) Observe(r *http.Request, peerIP string) (out *http.Request, finish func()) {
	r.Header.Del(IDHeader)
	s.mu.Lock()
	s.stats.Requests++
	s.mu.Unlock()
	noop := func() {}
	n, off := s.Native()
	if n == nil {
		s.declined("native route off: " + off)
		return r, noop
	}
	limit := s.MaxBody
	if limit <= 0 {
		limit = defaultMaxBody
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	switch {
	case err != nil:
		// The relay sees the same failure where it left off.
		r.Body = readCloser{io.MultiReader(bytes.NewReader(raw), errReader{err}), r.Body}
		s.declined("reading the request body failed")
		return r, noop
	case int64(len(raw)) > limit:
		r.Body = readCloser{io.MultiReader(bytes.NewReader(raw), r.Body), r.Body}
		s.declined("a body over the shadow's limit")
		return r, noop
	}
	r.Body = readCloser{bytes.NewReader(raw), r.Body}
	rec := &record{n: n}
	plan, err := n.Plan(r.Context(), native.Incoming{Header: r.Header, Host: r.Host, RawQuery: r.URL.RawQuery, PeerIP: peerIP}, raw)
	switch {
	case err == nil:
		rec.plan = plan
	case decline.Is(err):
		s.declined(err.Error())
	default:
		s.mu.Lock()
		s.stats.Errors++
		s.mu.Unlock()
		s.declined("an error: " + err.Error())
	}
	id := randomID()
	s.mu.Lock()
	if s.pending == nil {
		s.pending = map[string]*record{}
	}
	if len(s.pending) >= maxPending {
		s.mu.Unlock()
		if plan != nil {
			s.declined("too many requests awaiting reports")
		}
		return r, noop
	}
	if plan != nil {
		s.stats.Planned++
	}
	s.pending[id] = rec
	s.mu.Unlock()
	r.Header.Set(IDHeader, id)
	grace := s.Grace
	if grace <= 0 {
		grace = defaultGrace
	}
	return r, func() { time.AfterFunc(grace, func() { s.score(id) }) }
}

// score ends a request: a planned one Node sent nothing for is NoSend.
func (s *Shadow) score(id string) {
	s.mu.Lock()
	rec := s.pending[id]
	delete(s.pending, id)
	if rec == nil || rec.scored {
		s.mu.Unlock()
		return
	}
	rec.scored = true
	noSend := rec.plan != nil && rec.sends == 0
	if noSend {
		s.stats.NoSend++
		s.diffLocked(id + ": Node sent nothing; Go would have sent")
	}
	s.mu.Unlock()
	if noSend {
		s.logf("%s: Node answered without sending upstream; the native route would have sent (%s)", id, rec.plan.Request.Model)
	}
}

// Report is one send as Node's proxyAwareFetch got it.
type Report struct {
	ID     string `json:"id"`
	URL    string `json:"url"`
	Method string `json:"method"`
	// HeadersKind is "object" for a plain headers object, whose entries are
	// Headers in key order, values as String() makes them.
	HeadersKind string      `json:"headersKind"`
	Headers     [][2]string `json:"headers"`
	// BodyKind is "string" for a string body, Body its UTF-8 bytes.
	BodyKind string `json:"bodyKind"`
	Body     []byte `json:"body"`
}

// ServeReport takes a report from Node: a loopback peer with the token.
func (s *Shadow) ServeReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip, perr := netip.ParseAddr(host)
	if err != nil || perr != nil || !ip.Unmap().IsLoopback() {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	given := r.Header.Get(TokenHeader)
	if s.Token == "" || subtle.ConstantTimeCompare([]byte(given), []byte(s.Token)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxReport+1))
	if err != nil || len(raw) > maxReport {
		http.Error(w, "bad report", http.StatusRequestEntityTooLarge)
		return
	}
	var rep Report
	if err := json.Unmarshal(raw, &rep); err != nil || rep.ID == "" {
		s.mu.Lock()
		s.stats.Errors++
		s.mu.Unlock()
		http.Error(w, "bad report", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
	s.Compare(r.Context(), rep)
}

// Compare scores one of Node's sends.
func (s *Shadow) Compare(ctx context.Context, rep Report) {
	s.mu.Lock()
	s.stats.Sends++
	rec := s.pending[rep.ID]
	if rec != nil {
		rec.sends++
	}
	switch {
	case rec == nil:
		s.stats.Unknown++
		s.mu.Unlock()
		return
	case rec.plan == nil:
		s.stats.Unplanned++
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	diff, err := match(ctx, rec.n, rec.plan, rep)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case err != nil:
		s.stats.Errors++
		s.diffLocked(rep.ID + ": " + err.Error())
		s.logf("%s: comparing failed: %v", rep.ID, err)
	case diff == "":
		s.stats.Matched++
	default:
		s.stats.Differed++
		s.diffLocked(rep.ID + ": " + diff)
		s.logf("%s: differs from Node's send: %s", rep.ID, diff)
	}
}

// match prepares the attempt for every key of the plan's leaves whose
// credential Node's headers carry, and returns "" when one is Node's send
// exactly, else the first candidate's difference.
func match(ctx context.Context, n *native.Native, p *native.Plan, rep Report) (string, error) {
	switch {
	case rep.Method != http.MethodPost:
		return "method " + rep.Method, nil
	case rep.HeadersKind != "object":
		return "Node's headers are a " + rep.HeadersKind + ", not a plain object", nil
	case rep.BodyKind != "string":
		return "Node's body is a " + rep.BodyKind + ", not a string", nil
	}
	active := true
	first, tried := "", 0
	for _, l := range p.Leaves {
		rows, err := n.DB.ListConnections(ctx, l.Provider, &active)
		if err != nil {
			return "", err
		}
		for _, c := range rows {
			if !carriesCredential(rep.Headers, c) {
				continue
			}
			tried++
			where := l.Provider + " " + l.Model + " key " + c.ID
			prepare, err := n.Prepare(p, l, c)
			if err != nil {
				first = firstOf(first, where+": Go declines: "+err.Error())
				continue
			}
			node, err := claudeprep.ParseNodeSettings(jsjson.Marshal(c.ProviderSpecificData()))
			if err != nil {
				first = firstOf(first, where+": Go declines: "+err.Error())
				continue
			}
			req, err := prepare(node)
			if err != nil {
				first = firstOf(first, where+": Go declines: "+err.Error())
				continue
			}
			d := Diff(req, rep, c)
			if d == "" {
				return "", nil
			}
			first = firstOf(first, where+": "+d)
		}
	}
	if tried == 0 {
		return "Node sent with a credential none of the plan's keys hold (to " + redactURL(rep.URL) + ")", nil
	}
	return first, nil
}

func firstOf(have, next string) string {
	if have != "" {
		return have
	}
	return next
}

// carriesCredential: one of Node's header values holds c's key or token.
func carriesCredential(h [][2]string, c *db.Connection) bool {
	for _, key := range []string{"apiKey", "accessToken"} {
		cred := c.String(key)
		if cred == "" {
			continue
		}
		for _, kv := range h {
			if strings.Contains(kv[1], cred) {
				return true
			}
		}
	}
	return false
}

// secretHeaders are never quoted in a difference.
var secretHeaders = map[string]bool{"authorization": true, "x-api-key": true, "api-key": true, "cookie": true, "proxy-authorization": true}

// Diff is the first difference between Go's request and Node's send, ""
// when they are the same. Credentials and URL queries are never quoted.
func Diff(req *claudeprep.Request, rep Report, c *db.Connection) string {
	if req.URL != rep.URL {
		return fmt.Sprintf("URL: Go %s, Node %s", redactURL(req.URL), redactURL(rep.URL))
	}
	quote := func(name, value string) string {
		if secretHeaders[strings.ToLower(name)] || (c != nil && carriesCredential([][2]string{{name, value}}, c)) {
			return fmt.Sprintf("%s: (%d bytes, not shown)", name, len(value))
		}
		return fmt.Sprintf("%s: %q", name, value)
	}
	for i := 0; i < len(req.Header) || i < len(rep.Headers); i++ {
		var g, nd string
		if i < len(req.Header) {
			g = quote(req.Header[i].Name, req.Header[i].Value)
		}
		if i < len(rep.Headers) {
			nd = quote(rep.Headers[i][0], rep.Headers[i][1])
		}
		if i >= len(req.Header) || i >= len(rep.Headers) || req.Header[i].Name != rep.Headers[i][0] || req.Header[i].Value != rep.Headers[i][1] {
			return fmt.Sprintf("header %d: Go [%s], Node [%s]; Go's names %s, Node's %s", i, g, nd, headerNames(req.Header), reportNames(rep.Headers))
		}
	}
	if !bytes.Equal(req.Body, rep.Body) {
		at := 0
		for at < len(req.Body) && at < len(rep.Body) && req.Body[at] == rep.Body[at] {
			at++
		}
		return fmt.Sprintf("body (%d vs %d bytes) differs at byte %d: Go %q, Node %q", len(req.Body), len(rep.Body), at, window(req.Body, at), window(rep.Body, at))
	}
	return ""
}

func headerNames(h []claudeprep.HeaderField) string {
	names := make([]string, len(h))
	for i, f := range h {
		names[i] = f.Name
	}
	return "[" + strings.Join(names, " ") + "]"
}

func reportNames(h [][2]string) string {
	names := make([]string, len(h))
	for i, kv := range h {
		names[i] = kv[0]
	}
	return "[" + strings.Join(names, " ") + "]"
}

// window is up to 60 bytes either side of at.
func window(b []byte, at int) string {
	lo, hi := at-60, at+60
	if lo < 0 {
		lo = 0
	}
	if hi > len(b) {
		hi = len(b)
	}
	if lo > hi {
		lo = hi
	}
	return string(b[lo:hi])
}

// redactURL is the URL without its query (which may hold a key).
func redactURL(s string) string {
	u, err := url.Parse(s)
	if err != nil {
		return "(a URL that doesn't parse)"
	}
	if u.RawQuery != "" {
		u.RawQuery = "(query)"
	}
	u.User = nil
	u.Fragment = ""
	return u.String()
}

// Health is the counters for the health endpoint (this machine's clients).
func (s *Shadow) Health() map[string]any {
	st := s.Snapshot()
	reasons := make([]map[string]any, 0, len(st.Reasons))
	for k, v := range st.Reasons {
		reasons = append(reasons, map[string]any{"reason": k, "count": v})
	}
	sort.Slice(reasons, func(i, j int) bool {
		ci, cj := reasons[i]["count"].(int), reasons[j]["count"].(int)
		if ci != cj {
			return ci > cj
		}
		return reasons[i]["reason"].(string) < reasons[j]["reason"].(string)
	})
	return map[string]any{
		"requests": st.Requests, "planned": st.Planned, "declined": st.Declined,
		"sends": st.Sends, "matched": st.Matched, "differed": st.Differed,
		"unplanned": st.Unplanned, "unknown": st.Unknown, "noSend": st.NoSend, "errors": st.Errors,
		"reasons": reasons, "diffs": st.Diffs,
	}
}
