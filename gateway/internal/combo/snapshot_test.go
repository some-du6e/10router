package combo

import (
	"testing"

	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

func TestFromSnapshotKeepsTableOrder(t *testing.T) {
	node := func(id, typ, data string) *db.ProviderNode {
		o, err := jsjson.ParseObject([]byte(data))
		if err != nil {
			t.Fatal(err)
		}
		return &db.ProviderNode{ID: id, Type: &typ, Data: o}
	}
	s := &db.Snapshot{
		Nodes: map[string]*db.ProviderNode{
			"b": node("b", "openai-compatible", `{"prefix":"hot"}`),
			"a": node("a", "openai-compatible", `{"prefix":"hot"}`),
			"c": node("c", "openai-compatible", `{"prefix":7}`),
		},
		NodeOrder:    []string{"b", "a", "c"},
		Combos:       map[string]*db.Combo{"main": {Name: "main", Models: []any{"hot/x"}}},
		ModelAliases: jsjson.NewObject(),
	}
	c := FromSnapshot(s)
	info, err := c.ModelInfo("hot/x")
	if err != nil || info.Provider != "b" {
		t.Fatalf("the first node in table order wins: %+v %v", info, err)
	}
	if c.Nodes[2].HasPrefix {
		t.Fatal("a non-string prefix matches nothing")
	}
	members, err := c.ComboModels("main")
	if err != nil || len(members) != 1 || members[0] != "hot/x" {
		t.Fatalf("members %v %v", members, err)
	}
}
