package clientauth

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/some-du6e/10router/gateway/internal/clientip"
	"github.com/some-du6e/10router/gateway/internal/combo"
	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/dbtest"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
	"github.com/some-du6e/10router/gateway/internal/decline"
)

// fixture is testdata/cases.json, recorded from Node by
// tests/unit/gateway-clientauth-parity.test.js.
type fixture struct {
	// Rows are the tables as Node stored them.
	Rows            map[string][]map[string]any `json:"rows"`
	ComboStrategies json.RawMessage             `json:"comboStrategies"`
	Cases           []struct {
		Name          string            `json:"name"`
		SocketIP      string            `json:"socketIp"`
		Headers       map[string]string `json:"headers"`
		Query         string            `json:"query"`
		Model         string            `json:"model"`
		RequireAPIKey json.RawMessage   `json:"requireApiKey"`
		ComboStrategy string            `json:"comboStrategy"`
		Conservative  string            `json:"conservative"`
		Node          struct {
			Gate      any     `json:"gate"`
			Chat      any     `json:"chat"`
			Key       *string `json:"key"`
			HasBudget bool    `json:"hasBudget"`
		} `json:"node"`
	} `json:"cases"`
}

// load reads the fixture and puts its rows in a database shaped like Node's,
// read back through the gateway's readers: keys by APIKeyByKey (scanAPIKey),
// combos and aliases by the snapshot.
func load(t *testing.T) (*fixture, *db.DB, *combo.Config) {
	t.Helper()
	raw, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	path, node := dbtest.New(t, dbtest.Options{})
	dbtest.InsertRows(t, node, f.Rows)
	d, err := db.Open(path, db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	s, err := d.LoadSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return &f, d, combo.FromSnapshot(s)
}

// wireHeader is the header as net/http parses it off the wire: values have
// their surrounding spaces and tabs trimmed, as Node's parser trims them.
func wireHeader(m map[string]string) (http.Header, string) {
	h := http.Header{}
	host := ""
	for k, v := range m {
		v = strings.Trim(v, " \t")
		if k == "host" {
			host = v
			continue
		}
		h.Add(k, v)
	}
	return h, host
}

func TestChecksParityWithNode(t *testing.T) {
	f, d, combos := load(t)
	if len(f.Cases) < 150 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	strategies, err := jsjson.Parse(f.ComboStrategies)
	if err != nil {
		t.Fatal(err)
	}
	policy := func(key string) (*db.APIKey, error) { return d.APIKeyByKey(context.Background(), key) }
	rule := clientip.NewRule("")
	for _, tc := range f.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			settings := jsjson.NewObject()
			settings.Set("comboStrategy", tc.ComboStrategy)
			settings.Set("comboStrategies", strategies)
			require, err := jsjson.Parse(tc.RequireAPIKey)
			if err != nil {
				t.Fatal(err)
			}
			settings.Set("requireApiKey", require)
			s := db.Settings{Merged: settings}

			h, host := wireHeader(tc.Headers)
			model, _ := combo.StripContextMarker(tc.Model)
			dec, err := Check(
				Request{Header: h, Host: host, RawQuery: tc.Query, PeerIP: tc.SocketIP, Model: model},
				Config{Rule: rule, RequireAPIKey: s.Truthy("requireApiKey"), Policy: policy, Lookup: &Lookup{Combos: combos, Settings: s}, Now: time.Now()},
			)
			nodePass := tc.Node.Gate == "next" && tc.Node.Chat == "pass"
			if err != nil {
				if !decline.Is(err) {
					t.Fatalf("not a decline: %v", err)
				}
				if nodePass && tc.Conservative == "" {
					t.Fatalf("Go declined a request Node serves: %v", err)
				}
				if tc.Conservative != "" && !strings.Contains(err.Error(), tc.Conservative) {
					t.Fatalf("declined for another reason than %q: %v", tc.Conservative, err)
				}
				return
			}
			if !nodePass {
				t.Fatalf("Go lets through a request Node refuses (gate %v, chat %v)", tc.Node.Gate, tc.Node.Chat)
			}
			if tc.Conservative != "" {
				t.Fatalf("expected the conservative decline (%s)", tc.Conservative)
			}
			want := ""
			if tc.Node.Key != nil {
				want = *tc.Node.Key
			}
			if dec.Key != want || dec.HasBudget != tc.Node.HasBudget {
				t.Errorf("decision key=%q budget=%v, Node key=%q budget=%v", dec.Key, dec.HasBudget, want, tc.Node.HasBudget)
			}
		})
	}
}

func TestDeclinesRepeatedKeyHeaders(t *testing.T) {
	h := http.Header{}
	h.Add("X-Api-Key", "sk-a")
	h.Add("X-Api-Key", "sk-b")
	if _, err := ExtractKey(h, ""); !decline.Is(err) {
		t.Fatal("a repeated x-api-key must go to Node")
	}
	h = http.Header{"X-Api-Key": {"sk-é"}}
	if _, err := ExtractKey(h, ""); !decline.Is(err) {
		t.Fatal("a non-ASCII key must go to Node")
	}
}

func TestDeclinesExpiryNodeParsesItsOwnWay(t *testing.T) {
	for _, at := range []string{"2999-01-01", "Jan 1 2999", "2999-01-01T00:00:00Z"} {
		k := &db.APIKey{Key: "sk", IsActive: true, ExpiresAt: at}
		_, err := Check(Request{Header: http.Header{"X-Api-Key": {"sk"}}, PeerIP: "203.0.113.7", Host: "x.test", Model: "main"},
			Config{Rule: clientip.NewRule(""), RequireAPIKey: true, Policy: func(string) (*db.APIKey, error) { return k, nil }, Now: time.Now()})
		if !decline.Is(err) {
			t.Errorf("expiresAt %q was read; it must go to Node: %v", at, err)
		}
	}
}

// Node indexes a comboStrategies array or string by the combo's name.
func TestDeclinesComboStrategiesThatIsNotAnObject(t *testing.T) {
	_, _, combos := load(t)
	settings, err := jsjson.ParseObject([]byte(`{"comboStrategies":[{"fallbackStrategy":"fusion"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = IsModelAllowed("main", []string{"hot/model-a", "hot/model-b"}, &Lookup{Combos: combos, Settings: db.Settings{Merged: settings}})
	if !decline.Is(err) {
		t.Fatalf("got %v", err)
	}
}

// Without a lookup a combo can't be walked, so an allowlist is Node's to check.
func TestDeclinesAllowlistWithoutALookup(t *testing.T) {
	for _, model := range []string{"main", "prov/foo"} {
		if _, err := IsModelAllowed(model, []string{"MAIN", "foo"}, nil); !decline.Is(err) {
			t.Errorf("%s: got %v", model, err)
		}
		if _, err := IsModelAllowed(model, []string{"foo"}, &Lookup{}); !decline.Is(err) {
			t.Errorf("%s with no combos: got %v", model, err)
		}
	}
}

// Spend Node reads its own way: NaN is 0 to budgetState, and text that SQLite
// couldn't read as a number may still be one to Number().
func TestBudgetWithSpendNodeReadsItsOwnWay(t *testing.T) {
	zero := 0.0
	check := func(k *db.APIKey) error {
		_, err := Check(Request{Header: http.Header{"X-Api-Key": {"sk"}}, PeerIP: "203.0.113.7", Host: "x.test", Model: "main"},
			Config{Rule: clientip.NewRule(""), RequireAPIKey: true, Policy: func(string) (*db.APIKey, error) { return k, nil }, Now: time.Now()})
		return err
	}
	nan := &db.APIKey{Key: "sk", IsActive: true, BudgetUsd: &zero, SpentUsd: math.NaN()}
	if err := check(nan); !decline.Is(err) || !strings.Contains(err.Error(), "spent budget") {
		t.Errorf("a $0 budget with NaN spend is spent in Node: %v", err)
	}
	text := &db.APIKey{Key: "sk", IsActive: true, BudgetUsd: &zero, SpendNotNumeric: true}
	if err := check(text); !decline.Is(err) {
		t.Errorf("non-numeric spend: %v", err)
	}
}

// A failed key read is an error, not a decline: the caller decides.
func TestPolicyReadFailure(t *testing.T) {
	boom := errors.New("disk I/O error")
	_, err := Check(Request{Header: http.Header{"X-Api-Key": {"sk"}}, PeerIP: "203.0.113.7", Host: "x.test", Model: "main"},
		Config{Rule: clientip.NewRule(""), Policy: func(string) (*db.APIKey, error) { return nil, boom }, Now: time.Now()})
	if !errors.Is(err, boom) || decline.Is(err) {
		t.Fatalf("got %v", err)
	}
}
