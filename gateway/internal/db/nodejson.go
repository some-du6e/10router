package db

import "github.com/some-du6e/10router/gateway/internal/db/jsjson"

// The objects Node's repos return for each row, key for key, so a row can be
// compared with what Node reads from it (tests/unit/gateway-db-parity.test.js).

func strOrNull(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func boolOrNull(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

func floatOrNull(f *float64) any {
	if f == nil {
		return nil
	}
	return *f
}

// sqlValue is a column value as Node's drivers hand it to JavaScript.
func sqlValue(v any) any {
	switch t := v.(type) {
	case int64:
		return float64(t)
	case []byte:
		return string(t)
	}
	return v
}

// NodeObject is rowToKey(row).
func (k *APIKey) NodeObject() *jsjson.Object {
	o := jsjson.NewObject()
	o.Set("id", k.ID)
	o.Set("key", k.Key)
	o.Set("name", strOrNull(k.Name))
	o.Set("machineId", strOrNull(k.MachineID))
	o.Set("isActive", k.IsActive)
	o.Set("limitHold", boolOrNull(k.LimitHold))
	o.Set("createdAt", k.CreatedAt)
	o.Set("budgetUsd", floatOrNull(k.BudgetUsd))
	if k.AllowedModels == nil {
		o.Set("allowedModels", nil)
	} else {
		o.Set("allowedModels", k.AllowedModels)
	}
	o.Set("expiresAt", orNull(k.ExpiresAt))
	o.Set("spentUsd", k.SpentUsd)
	o.Set("lifetimeSpentUsd", k.LifetimeSpentUsd)
	o.Set("spendOffsetUsd", k.SpendOffsetUsd)
	o.Set("spendResetAt", orNull(k.SpendResetAt))
	o.Set("requestCount", k.RequestCount)
	o.Set("lastUsedAt", orNull(k.LastUsedAt))
	o.Set("ownerManagementKeyId", orNull(k.OwnerManagementKeyID))
	o.Set("disabledBy", orNull(k.DisabledBy))
	o.Set("expiresAtSetBy", orNull(k.ExpiresAtSetBy))
	return o
}

// NodeObject is rowToConn(row): the data fields, then the columns.
func (c *Connection) NodeObject() *jsjson.Object {
	o := c.Data.Clone()
	o.Set("id", c.ID)
	o.Set("provider", c.Provider)
	o.Set("authType", c.AuthType)
	o.Set("name", strOrNull(c.Name))
	o.Set("email", strOrNull(c.Email))
	o.Set("priority", sqlValue(c.Priority))
	o.Set("isActive", c.IsActive)
	o.Set("createdAt", c.CreatedAt)
	o.Set("updatedAt", c.UpdatedAt)
	return o
}

// NodeObject is rowToNode(row).
func (n *ProviderNode) NodeObject() *jsjson.Object {
	o := n.Data.Clone()
	o.Set("id", n.ID)
	o.Set("type", strOrNull(n.Type))
	o.Set("name", strOrNull(n.Name))
	o.Set("createdAt", n.CreatedAt)
	o.Set("updatedAt", n.UpdatedAt)
	return o
}

// NodeObject is rowToCombo(row).
func (c *Combo) NodeObject() *jsjson.Object {
	o := jsjson.NewObject()
	o.Set("id", c.ID)
	o.Set("name", c.Name)
	o.Set("kind", strOrNull(c.Kind))
	o.Set("models", c.Models)
	o.Set("createdAt", c.CreatedAt)
	o.Set("updatedAt", c.UpdatedAt)
	return o
}

// NodeObject is rowToPool(row).
func (p *ProxyPool) NodeObject() *jsjson.Object {
	o := p.Data.Clone()
	o.Set("id", p.ID)
	o.Set("isActive", p.IsActive)
	o.Set("testStatus", strOrNull(p.TestStatus))
	o.Set("createdAt", p.CreatedAt)
	o.Set("updatedAt", p.UpdatedAt)
	return o
}
