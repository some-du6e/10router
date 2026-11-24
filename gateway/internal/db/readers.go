package db

import (
	"context"
	"database/sql"
	"errors"
	"math"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// parseJSONOr is jsonCol.js's parseJson(str, fallback) for a column: NULL
// or unreadable text is the fallback.
func parseJSONOr(text sql.NullString, fallback any) any {
	if !text.Valid {
		return fallback
	}
	v, err := jsjson.Parse([]byte(text.String))
	if err != nil {
		return fallback
	}
	return v
}

// parseObjectOr is parseJson(str, {}) where the caller spreads the result
// into an object: anything but an object spreads to nothing.
func parseObjectOr(text sql.NullString) *jsjson.Object {
	if o, ok := parseJSONOr(text, nil).(*jsjson.Object); ok {
		return o
	}
	return jsjson.NewObject()
}

func nullString(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	v := s.String
	return &v
}

// sqlNumber is a numeric column as a JavaScript number would read it.
func sqlNumber(v any) (float64, bool) {
	switch t := v.(type) {
	case int64:
		return float64(t), true
	case float64:
		return t, true
	}
	return 0, false
}

// isTrue1 is `row.x === 1 || row.x === true` on an INTEGER column.
func isTrue1(v any) bool {
	n, ok := sqlNumber(v)
	return ok && n == 1
}

// roundUsd is apiKeyLimits.js's Math.round(n * 1e6) / 1e6.
func roundUsd(n float64) float64 {
	return jsRound(n*1e6) / 1e6
}

// jsRound is Math.round: halves round toward +Infinity.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// APIKey is apiKeysRepo.js's rowToKey.
type APIKey struct {
	ID        string
	Key       string
	Name      *string
	MachineID *string
	IsActive  bool
	// LimitHold is nil to inherit the global setting.
	LimitHold *bool
	CreatedAt string
	// BudgetUsd is nil for no budget.
	BudgetUsd *float64
	// AllowedModels is nil for every model.
	AllowedModels []string
	ExpiresAt     string
	// SpentUsd counts against the budget (since the last reset).
	SpentUsd         float64
	LifetimeSpentUsd float64
	SpendOffsetUsd   float64
	// SpendNotNumeric: spentUsd or spendOffsetUsd holds a value that isn't a
	// number (read as 0 above, where Node's Number() might read one).
	SpendNotNumeric      bool
	SpendResetAt         string
	RequestCount         float64
	LastUsedAt           string
	OwnerManagementKeyID string
	DisabledBy           string
	ExpiresAtSetBy       string
}

const apiKeyColumns = `id, key, name, machineId, isActive, limitHold, createdAt, budgetUsd, allowedModels, expiresAt, spentUsd, spendOffsetUsd, spendResetAt, requestCount, lastUsedAt, ownerManagementKeyId, disabledBy, expiresAtSetBy`

func scanAPIKey(scan func(...any) error) (*APIKey, error) {
	var (
		k                                                                  APIKey
		name, machineID, allowed, expiresAt, resetAt, lastUsed, owner, dis sql.NullString
		setBy                                                              sql.NullString
		isActive, limitHold, budget, spent, offset, count                  any
		createdAt                                                          sql.NullString
	)
	if err := scan(&k.ID, &k.Key, &name, &machineID, &isActive, &limitHold, &createdAt, &budget, &allowed, &expiresAt,
		&spent, &offset, &resetAt, &count, &lastUsed, &owner, &dis, &setBy); err != nil {
		return nil, err
	}
	k.Name, k.MachineID = nullString(name), nullString(machineID)
	k.IsActive = isTrue1(isActive)
	if n, ok := sqlNumber(limitHold); ok {
		b := n == 1
		k.LimitHold = &b
	}
	k.CreatedAt = createdAt.String
	if n, ok := sqlNumber(budget); ok && !math.IsInf(n, 0) && !math.IsNaN(n) {
		k.BudgetUsd = &n
	}
	if list, ok := parseJSONOr(allowed, nil).([]any); ok {
		for _, m := range list {
			if s, ok := m.(string); ok {
				k.AllowedModels = append(k.AllowedModels, s)
			}
		}
		if len(list) == 0 {
			k.AllowedModels = nil
		} else if k.AllowedModels == nil {
			k.AllowedModels = []string{}
		}
	}
	k.ExpiresAt = expiresAt.String
	k.LifetimeSpentUsd, _ = sqlNumber(spent)
	k.SpendOffsetUsd, _ = sqlNumber(offset)
	// Text in a REAL column is text SQLite couldn't read as a number, which
	// Number() still may ("0x10"). Read as 0 here; callers that judge a
	// budget by it decline.
	for _, v := range []any{spent, offset} {
		if _, ok := sqlNumber(v); !ok && v != nil {
			k.SpendNotNumeric = true
		}
	}
	k.SpentUsd = math.Max(0, roundUsd(k.LifetimeSpentUsd-k.SpendOffsetUsd))
	k.SpendResetAt = resetAt.String
	k.RequestCount, _ = sqlNumber(count)
	k.LastUsedAt = lastUsed.String
	k.OwnerManagementKeyID, k.DisabledBy, k.ExpiresAtSetBy = owner.String, dis.String, setBy.String
	return &k, nil
}

// APIKeyByKey is getApiKeyPolicy(key): one indexed read, fresh, so spend is
// current. Nil when the key is not one 10router issued.
func (d *DB) APIKeyByKey(ctx context.Context, key string) (*APIKey, error) {
	if key == "" {
		return nil, nil
	}
	row := d.readers.QueryRowContext(ctx, `SELECT `+apiKeyColumns+` FROM apiKeys WHERE key = ?`, key)
	k, err := scanAPIKey(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return k, err
}

// Combo is combosRepo.js's rowToCombo.
type Combo struct {
	ID   string
	Name string
	Kind *string
	// Models is parseJson(row.models, []): normally an array, but whatever
	// JSON the column holds (Node's getComboModels takes a non-empty string
	// as members too).
	Models    any
	CreatedAt string
	UpdatedAt string
}

// ProviderNode is nodesRepo.js's rowToNode: the data JSON with the columns
// over it. The fields the gateway routes on are typed; Data has the rest.
type ProviderNode struct {
	ID        string
	Type      *string
	Name      *string
	CreatedAt string
	UpdatedAt string
	// Data is the stored data JSON (every key but the columns).
	Data *jsjson.Object
}

// Field is a key of the node's data.
func (n *ProviderNode) Field(key string) (any, bool) { return n.Data.Get(key) }

// String is a data key when it is a string, else "".
func (n *ProviderNode) String(key string) string {
	v, _ := n.Data.Get(key)
	s, _ := v.(string)
	return s
}

// Prefix, BaseURL and APIType are the node's routing fields.
func (n *ProviderNode) Prefix() string  { return n.String("prefix") }
func (n *ProviderNode) BaseURL() string { return n.String("baseUrl") }
func (n *ProviderNode) APIType() string { return n.String("apiType") }

// DroppedBetas are the beta flags the endpoint rejected.
func (n *ProviderNode) DroppedBetas() []string { return stringList(n.Data, "droppedBetas") }

// ModelRoutes maps a model to the API it is served on (nil when unset).
func (n *ProviderNode) ModelRoutes() *jsjson.Object {
	v, _ := n.Data.Get("modelRoutes")
	o, _ := v.(*jsjson.Object)
	return o
}

// Overrides are the node's raw endpoint overrides (nil when unset).
func (n *ProviderNode) Overrides() any {
	v, _ := n.Data.Get("overrides")
	return v
}

func stringList(o *jsjson.Object, key string) []string {
	v, _ := o.Get(key)
	list, _ := v.([]any)
	var out []string
	for _, e := range list {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ProxyPool is proxyPoolsRepo.js's rowToPool.
type ProxyPool struct {
	ID         string
	IsActive   bool
	TestStatus *string
	CreatedAt  string
	UpdatedAt  string
	Data       *jsjson.Object
}

// ProxyPoolByID is getProxyPoolById(id), read fresh. Nil when there is none.
func (d *DB) ProxyPoolByID(ctx context.Context, id string) (*ProxyPool, error) {
	var (
		p          ProxyPool
		isActive   any
		status     sql.NullString
		data       sql.NullString
		created, u sql.NullString
	)
	err := d.readers.QueryRowContext(ctx, `SELECT id, isActive, testStatus, data, createdAt, updatedAt FROM proxyPools WHERE id = ?`, id).
		Scan(&p.ID, &isActive, &status, &data, &created, &u)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.IsActive = isTrue1(isActive)
	p.TestStatus = nullString(status)
	p.CreatedAt, p.UpdatedAt = created.String, u.String
	p.Data = stripKeys(parseObjectOr(data), "id", "isActive", "testStatus", "createdAt", "updatedAt")
	return &p, nil
}

// stripKeys removes the keys a row's columns replace, which Node's spread
// over the columns would hide and its next write would drop.
func stripKeys(o *jsjson.Object, keys ...string) *jsjson.Object {
	for _, k := range keys {
		o.Delete(k)
	}
	return o
}
