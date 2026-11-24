package clientauth

import (
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
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// fixture is testdata/cases.json, recorded from Node by
// tests/unit/gateway-clientauth-parity.test.js.
type fixture struct {
	DB struct {
		Keys            []map[string]any `json:"keys"`
		Combos          map[string][]any `json:"combos"`
		Aliases         json.RawMessage  `json:"aliases"`
		ComboStrategies json.RawMessage  `json:"comboStrategies"`
	} `json:"db"`
	Cases []struct {
		Name          string            `json:"name"`
		SocketIP      string            `json:"socketIp"`
		Headers       map[string]string `json:"headers"`
		Query         string            `json:"query"`
		Model         string            `json:"model"`
		RequireAPIKey bool              `json:"requireApiKey"`
		Conservative  string            `json:"conservative"`
		Node          struct {
			Gate      any     `json:"gate"`
			Chat      any     `json:"chat"`
			Key       *string `json:"key"`
			HasBudget bool    `json:"hasBudget"`
		} `json:"node"`
	} `json:"cases"`
}

// keyFromRow is apiKeysRepo.js's rowToKey for the fields the checks read.
func keyFromRow(row map[string]any) *db.APIKey {
	k := &db.APIKey{Key: row["key"].(string)}
	if n, _ := row["isActive"].(float64); n == 1 {
		k.IsActive = true
	}
	if b, ok := row["budgetUsd"].(float64); ok {
		k.BudgetUsd = &b
	}
	spent, _ := row["spentUsd"].(float64)
	offset, _ := row["spendOffsetUsd"].(float64)
	k.SpentUsd = math.Max(0, math.Round((spent-offset)*1e6)/1e6)
	if s, ok := row["allowedModels"].(string); ok {
		var list []any
		_ = json.Unmarshal([]byte(s), &list)
		for _, m := range list {
			if str, ok := m.(string); ok {
				k.AllowedModels = append(k.AllowedModels, str)
			}
		}
	}
	k.ExpiresAt, _ = row["expiresAt"].(string)
	return k
}

func load(t *testing.T) (*fixture, func(key string) (*db.APIKey, error), *Lookup) {
	t.Helper()
	raw, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	keys := map[string]*db.APIKey{}
	for _, row := range f.DB.Keys {
		k := keyFromRow(row)
		keys[k.Key] = k
	}
	policy := func(key string) (*db.APIKey, error) { return keys[key], nil }
	aliases, err := jsjson.ParseObject(f.DB.Aliases)
	if err != nil {
		t.Fatal(err)
	}
	strategies, err := jsjson.Parse(f.DB.ComboStrategies)
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := jsjson.ParseObject([]byte(`{"comboStrategy":"fallback"}`))
	settings.Set("comboStrategies", strategies)
	lookup := &Lookup{
		Combos:   &combo.Config{Combos: f.DB.Combos, Aliases: aliases},
		Settings: db.Settings{Merged: settings},
		Aliases:  aliases,
	}
	return &f, policy, lookup
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
	f, policy, lookup := load(t)
	if len(f.Cases) < 150 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	rule := clientip.NewRule("")
	for _, tc := range f.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			h, host := wireHeader(tc.Headers)
			model, _ := combo.StripContextMarker(tc.Model)
			d, err := Check(
				Request{Header: h, Host: host, RawQuery: tc.Query, PeerIP: tc.SocketIP, Model: model},
				Config{Rule: rule, RequireAPIKey: tc.RequireAPIKey, Policy: policy, Lookup: lookup, Now: time.Now()},
			)
			nodePass := tc.Node.Gate == "next" && tc.Node.Chat == "pass"
			if err != nil {
				var dec *DeclineError
				if !errors.As(err, &dec) {
					t.Fatalf("not a decline: %v", err)
				}
				if nodePass && tc.Conservative == "" {
					t.Fatalf("Go declined a request Node serves: %v", err)
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
			if d.Key != want || d.HasBudget != tc.Node.HasBudget {
				t.Errorf("decision key=%q budget=%v, Node key=%q budget=%v", d.Key, d.HasBudget, want, tc.Node.HasBudget)
			}
		})
	}
}

func TestDeclinesRepeatedKeyHeaders(t *testing.T) {
	h := http.Header{}
	h.Add("X-Api-Key", "sk-a")
	h.Add("X-Api-Key", "sk-b")
	if _, err := ExtractKey(h, ""); err == nil {
		t.Fatal("a repeated x-api-key must go to Node")
	}
	h = http.Header{"X-Api-Key": {"sk-é"}}
	if _, err := ExtractKey(h, ""); err == nil {
		t.Fatal("a non-ASCII key must go to Node")
	}
}

func TestDeclinesExpiryNodeParsesItsOwnWay(t *testing.T) {
	_, _, lookup := load(t)
	for _, at := range []string{"2999-01-01", "Jan 1 2999", "2999-01-01T00:00:00Z"} {
		k := &db.APIKey{Key: "sk", IsActive: true, ExpiresAt: at}
		_, err := Check(Request{Header: http.Header{"X-Api-Key": {"sk"}}, PeerIP: "203.0.113.7", Host: "x.test", Model: "main"},
			Config{Rule: clientip.NewRule(""), RequireAPIKey: true, Policy: func(string) (*db.APIKey, error) { return k, nil }, Lookup: lookup, Now: time.Now()})
		if err == nil {
			t.Errorf("expiresAt %q was read; it must go to Node", at)
		}
	}
}
