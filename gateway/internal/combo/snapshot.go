package combo

import "github.com/some-du6e/10router/gateway/internal/db"

// FromSnapshot is the resolution config one database snapshot holds.
func FromSnapshot(s *db.Snapshot) *Config {
	c := &Config{Combos: make(map[string]any, len(s.Combos)), Aliases: s.ModelAliases}
	for name, combo := range s.Combos {
		c.Combos[name] = combo.Models
	}
	for _, id := range s.NodeOrder {
		n := s.Nodes[id]
		node := Node{ID: n.ID}
		if n.Type != nil {
			node.Type = *n.Type
		}
		// node.prefix as rowToNode spreads it from the data JSON.
		if v, ok := n.Field("prefix"); ok {
			node.Prefix, node.HasPrefix = v.(string)
		}
		c.Nodes = append(c.Nodes, node)
	}
	return c
}
