// Package native is the gateway's own /v1/messages, up to the send: the
// request checks (route, clientauth), the routing plan (combo) and the
// per-key preflight (accounts, upstream), and the one Inputs builder Prepare
// gets for both the preflight's dry run and the attempt's send.
//
// Phase 2c runs it in shadow only (internal/shadow): Node serves every
// client, and the gateway compares what it would send with what Node sent.
package native

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/some-du6e/10router/gateway/internal/accounts"
	"github.com/some-du6e/10router/gateway/internal/claudeprep"
	"github.com/some-du6e/10router/gateway/internal/clientauth"
	"github.com/some-du6e/10router/gateway/internal/clientip"
	"github.com/some-du6e/10router/gateway/internal/combo"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
	"github.com/some-du6e/10router/gateway/internal/nodeevents"
	"github.com/some-du6e/10router/gateway/internal/route"
	"github.com/some-du6e/10router/gateway/internal/upstream"
)

const pkg = "native"

func declined(format string, args ...any) error { return decline.New(pkg, format, args...) }

// Native is the native route's state.
type Native struct {
	DB       *db.DB
	Accounts *accounts.Accounts
	Rule     *clientip.Rule
	// Models resolves capabilities (claudeprep.NewModels over the synced
	// catalog, NewFileCatalog).
	Models claudeprep.Models
	// Env is the process environment Node reads (os.Getenv when nil).
	Env upstream.Env
	// Now is the clock (time.Now when nil).
	Now func() time.Time
	// Events hands Node the writes it makes itself (learned beta flags).
	Events *nodeevents.Client
	Logger *log.Logger
}

// LearnedBetas is upstream.Input.LearnedBetas for key c: chatCore's
// onBetasRejected, which DefaultExecutor awaits before it returns and whose
// failure it only logs. Node writes the rows; the attempt's next key in the
// same request gets the flags through upstream.MergeDroppedBetas.
func (n *Native) LearnedBetas(provider string, c *db.Connection) func(flags []string) {
	return func(flags []string) {
		if n.Events == nil || len(flags) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := n.Events.BetasLearned(ctx, c.ID, provider, flags); err != nil && n.Logger != nil {
			n.Logger.Printf("[Gateway] native: handing learned beta flags for connection %s to the app server failed: %v", c.ID, err)
		}
	}
}

// New is the native route over d. env is the app server's environment:
// model hang's probe lease follows its UPSTREAM_STREAM_HEADERS_TIMEOUT_MS,
// as Node's does, and Prepare reads the catalog Node syncs into its data
// directory.
func New(d *db.DB, rule *clientip.Rule, env upstream.Env, catalogPath string) *Native {
	if env == nil {
		env = os.Getenv
	}
	a := accounts.New(d)
	a.Hang.BudgetMs = upstream.HeadersBudget(env, true).Ms
	var catalog claudeprep.Catalog
	if catalogPath != "" {
		catalog = claudeprep.DeclineCovered(claudeprep.NewFileCatalog(catalogPath))
	}
	return &Native{DB: d, Accounts: a, Rule: rule, Models: claudeprep.NewModels(catalog), Env: env}
}

// CatalogFile is catalogOverride.js's CATALOG_FILE for the database at
// dataFile (db.DataFile: DATA_DIR/db/data.sqlite): DATA_DIR/model-catalog.json.
func CatalogFile(dataFile string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(dataFile)), "model-catalog.json")
}

// Ready is nil when every package the route runs loaded its embedded
// tables (each reports a bad one here instead of panicking at start).
func Ready() error {
	return errors.Join(combo.Ready(), upstream.Ready())
}

func (n *Native) now() time.Time {
	if n.Now != nil {
		return n.Now()
	}
	return time.Now()
}

// Leaf is one provider model the plan reaches.
type Leaf struct{ Provider, Model string }

// Plan is a request the native route would serve: checked, routed, and
// every provider model it reaches preflighted.
type Plan struct {
	Raw      []byte
	Request  *route.Request
	Decision clientauth.Decision
	Settings db.Settings
	Target   *combo.Target
	// Leaves in the order the plan first reaches them, each once.
	Leaves []Leaf
	// ClientHeaders is the client's headers as Node's request.headers has
	// them (ClientHeaders).
	ClientHeaders map[string]string
}

// Incoming is the client's request as the gateway accepted it.
type Incoming struct {
	Header   http.Header
	Host     string
	RawQuery string
	// PeerIP is the connection's address (proxy.PeerOf).
	PeerIP string
}

// Plan runs everything before the account loop, as chat.ts does up to
// routeSingleModelChat's loop, and the preflight on each leaf: an error is a
// decline (decline.Is) or a database failure, and either way Node serves.
func (n *Native) Plan(ctx context.Context, in Incoming, raw []byte) (*Plan, error) {
	snap := n.DB.Snapshot()
	if snap == nil {
		return nil, declined("the config snapshot has not loaded")
	}
	req, err := route.Inspect(raw, in.Header, snap.Settings.Truthy("ccFilterNaming"))
	if err != nil {
		return nil, err
	}
	cfg := combo.FromSnapshot(snap)
	dec, err := clientauth.Check(clientauth.Request{Header: in.Header, Host: in.Host, RawQuery: in.RawQuery, PeerIP: in.PeerIP, Model: req.Model}, clientauth.Config{
		Rule:          n.Rule,
		RequireAPIKey: snap.Settings.Truthy("requireApiKey"),
		Policy:        func(key string) (*db.APIKey, error) { return n.DB.APIKeyByKey(ctx, key) },
		Lookup:        &clientauth.Lookup{Combos: cfg, Settings: snap.Settings},
		Now:           n.now(),
	})
	if err != nil {
		return nil, err
	}
	var hold *bool
	if dec.Policy != nil {
		hold = dec.Policy.LimitHold
	}
	headers := ClientHeaders(in.Header, in.Host)
	target, err := combo.Plan(combo.PlanInput{Config: cfg, Settings: snap.Settings, Model: req.Model, Body: req.Body, Headers: headers, KeyLimitHold: hold})
	if err != nil {
		return nil, err
	}
	p := &Plan{Raw: raw, Request: req, Decision: dec, Settings: snap.Settings, Target: target, ClientHeaders: headers}
	seen := map[Leaf]bool{}
	var walk func(*combo.Target)
	walk = func(t *combo.Target) {
		if t.Combo == "" {
			if l := (Leaf{t.Provider, t.Model}); !seen[l] {
				seen[l] = true
				p.Leaves = append(p.Leaves, l)
			}
			return
		}
		for _, m := range t.Members {
			walk(m)
		}
	}
	walk(target)
	for _, l := range p.Leaves {
		if err := n.Preflight(ctx, p, l); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// Preflight is combo.Env.Preflight for p: the provider's strategy and keys
// (accounts.CheckProvider), and on each key upstream.PreflightKey with the
// attempt's own Prepare.
func (n *Native) Preflight(ctx context.Context, p *Plan, l Leaf) error {
	return n.Accounts.CheckProvider(ctx, l.Provider, p.Settings, func(c *db.Connection) error {
		prepare, err := n.Prepare(p, l, c)
		if err != nil {
			return err
		}
		return upstream.PreflightKey(ctx, c, p.Settings, n.DB, n.Env, prepare)
	})
}

// Prepare is the attempt's upstream.Prepare for key c on leaf l: the one
// builder of claudeprep.Inputs, for the preflight's dry run and the send.
func (n *Native) Prepare(p *Plan, l Leaf, c *db.Connection) (upstream.Prepare, error) {
	apiKey, err := credential(c, "apiKey")
	if err != nil {
		return nil, err
	}
	accessToken, err := credential(c, "accessToken")
	if err != nil {
		return nil, err
	}
	thinking, err := ProviderThinking(p.Settings, l.Provider)
	if err != nil {
		return nil, err
	}
	return func(node claudeprep.NodeSettings) (*claudeprep.Request, error) {
		return claudeprep.Prepare(p.Raw, claudeprep.Inputs{
			Provider:         l.Provider,
			Model:            l.Model,
			ClientHeaders:    p.ClientHeaders,
			KeyHasBudget:     p.Decision.HasBudget,
			ProviderThinking: thinking,
			Connection:       claudeprep.Connection{APIKey: apiKey, AccessToken: accessToken, Node: node},
			Models:           n.Models,
		})
	}, nil
}

// credential is a connection's apiKey or accessToken: a string, or none.
// Anything else Node would put on the wire its own way.
func credential(c *db.Connection, key string) (string, error) {
	v, _ := c.Field(key)
	switch t := v.(type) {
	case nil:
		return "", nil
	case string:
		return t, nil
	}
	return "", declined("connection %s has a %s that isn't a string", c.ID, key)
}

// ProviderThinking is chat.ts's providerThinking for provider, as chatCore
// reads it: (settings.providerThinking || {})[provider], then its mode when
// truthy. A shape Node would read its own way is a decline.
func ProviderThinking(s db.Settings, provider string) (string, error) {
	all, _ := s.Get("providerThinking")
	if !jsjson.Truthy(all) {
		return "", nil
	}
	obj, ok := all.(*jsjson.Object)
	if !ok {
		return "", declined("a providerThinking setting that isn't an object")
	}
	entry, _ := obj.Get(provider)
	if !jsjson.Truthy(entry) {
		return "", nil
	}
	eo, ok := entry.(*jsjson.Object)
	if !ok {
		return "", declined("a providerThinking entry that isn't an object")
	}
	mode, _ := eo.Get("mode")
	if !jsjson.Truthy(mode) {
		return "", nil
	}
	m, ok := mode.(string)
	if !ok {
		return "", declined("a providerThinking mode that isn't a string")
	}
	return m, nil
}

// firstOnly are the headers Node's HTTP parser keeps only the first of
// (IncomingMessage's matchKnownFields: discard duplicates).
var firstOnly = map[string]bool{
	"age": true, "authorization": true, "content-length": true, "content-type": true, "etag": true,
	"expires": true, "from": true, "host": true, "if-modified-since": true, "if-unmodified-since": true,
	"last-modified": true, "location": true, "max-forwards": true, "proxy-authorization": true,
	"referer": true, "retry-after": true, "server": true, "user-agent": true,
}

// ClientHeaders is Object.fromEntries(request.headers) for the request Node
// gets: names lowercased, repeats as Node's parser folds them (the first of
// a firstOnly name, cookies joined with "; ", others with ", "), Host from
// the request line's authority. Prepare reads a handful of these by name.
func ClientHeaders(h http.Header, host string) map[string]string {
	out := make(map[string]string, len(h)+1)
	for name, values := range h {
		if len(values) == 0 {
			continue
		}
		n := strings.ToLower(name)
		switch {
		case firstOnly[n]:
			out[n] = values[0]
		case n == "cookie":
			out[n] = strings.Join(values, "; ")
		default:
			out[n] = strings.Join(values, ", ")
		}
	}
	if host != "" {
		out["host"] = host
	}
	return out
}
