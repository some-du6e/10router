package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Snapshot is the config the gateway caches between config generations:
// what Node reads on every request but changes only on a dashboard or
// management write, each of which bumps _meta.configGeneration. It is
// immutable once published; Watch swaps in a new one.
//
// Per-request state is not here: connections (locks, demotions, backoff)
// and API key spend are read fresh at pick time, as Node reads them.
type Snapshot struct {
	// Generation is _meta.configGeneration when the snapshot was read (0
	// before the first config write).
	Generation int64
	LoadedAt   time.Time

	Settings Settings
	// Combos by name.
	Combos map[string]*Combo
	// Nodes by id (provider node ids such as openai-compatible-chat-...).
	Nodes map[string]*ProviderNode
	// NodeOrder is the node ids in table (rowid) order: getProviderNodes'
	// order, which a prefix lookup's first match depends on.
	NodeOrder []string
	// APIKeys by key: the policy (isActive, limits, expiry, limitHold). The
	// spend in these copies is as of LoadedAt; use APIKeyByKey for spend.
	APIKeys map[string]*APIKey
	// ModelAliases is the modelAliases kv scope, alias → stored value, in the
	// order getModelAliases() returns it.
	ModelAliases *jsjson.Object
	// Pricing is the pricing kv scope (user overrides), provider → models.
	// The built-in tables are internal/usage's.
	Pricing *jsjson.Object
	// CustomModels is getCustomModels(), in its order.
	CustomModels []any
}

// Alias is the model an alias points at, when it is a string.
func (s *Snapshot) Alias(alias string) (string, bool) {
	v, ok := s.ModelAliases.Get(alias)
	if !ok {
		return "", false
	}
	str, ok := v.(string)
	return str, ok
}

// APIKeys is getApiKeys(): every key, oldest first.
func (d *DB) APIKeys(ctx context.Context) ([]*APIKey, error) {
	rows, err := d.readers.QueryContext(ctx, `SELECT `+apiKeyColumns+` FROM apiKeys ORDER BY createdAt ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*APIKey
	for rows.Next() {
		k, err := scanAPIKey(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// LoadSnapshot reads every snapshot table in one short read transaction, so
// they are from one point in time. Watch calls it; tools may too.
func (d *DB) LoadSnapshot(ctx context.Context) (*Snapshot, error) {
	s := &Snapshot{
		LoadedAt:     d.now(),
		Combos:       map[string]*Combo{},
		Nodes:        map[string]*ProviderNode{},
		APIKeys:      map[string]*APIKey{},
		ModelAliases: jsjson.NewObject(),
		Pricing:      jsjson.NewObject(),
	}
	err := d.readTx(ctx, func(tx *sql.Tx) error {
		var gen sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT value FROM _meta WHERE key = 'configGeneration'`).Scan(&gen)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		s.Generation = jsParseInt(gen.String)

		var raw sql.NullString
		err = tx.QueryRowContext(ctx, `SELECT data FROM settings WHERE id = 1`).Scan(&raw)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		s.Settings = mergeSettings(parseObjectOr(raw))

		if err := loadCombos(ctx, tx, s); err != nil {
			return err
		}
		if err := loadNodes(ctx, tx, s); err != nil {
			return err
		}
		if err := loadAPIKeys(ctx, tx, s); err != nil {
			return err
		}
		return loadKV(ctx, tx, s)
	})
	if err != nil {
		return nil, err
	}
	return s, nil
}

func loadCombos(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	rows, err := tx.QueryContext(ctx, `SELECT id, name, kind, models, createdAt, updatedAt FROM combos ORDER BY createdAt ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			c                   Combo
			kind, models, c1, u sql.NullString
		)
		if err := rows.Scan(&c.ID, &c.Name, &kind, &models, &c1, &u); err != nil {
			return err
		}
		c.Kind = nullString(kind)
		// parseJson(row.models, []): unreadable is [], and readable JSON that
		// isn't an array is kept as it is, as rowToCombo keeps it.
		c.Models = parseJSONOr(models, []any{})
		c.CreatedAt, c.UpdatedAt = c1.String, u.String
		// getComboByName: name is UNIQUE.
		s.Combos[c.Name] = &c
	}
	return rows.Err()
}

func scanNode(scan func(...any) error) (*ProviderNode, error) {
	var (
		n                     ProviderNode
		typ, name, data, c, u sql.NullString
	)
	if err := scan(&n.ID, &typ, &name, &data, &c, &u); err != nil {
		return nil, err
	}
	n.Type, n.Name = nullString(typ), nullString(name)
	n.CreatedAt, n.UpdatedAt = c.String, u.String
	n.Data = stripKeys(parseObjectOr(data), nodeColumnKeys...)
	return &n, nil
}

// nodeColumnKeys are nodesRepo.js's columns, which nodeToRow keeps out of data.
var nodeColumnKeys = []string{"id", "type", "name", "createdAt", "updatedAt"}

const nodeColumns = `id, type, name, data, createdAt, updatedAt`

func loadNodes(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	// getProviderNodes has no ORDER BY: a full scan, or idx_pn_type for one
	// type, reads in rowid order either way.
	rows, err := tx.QueryContext(ctx, `SELECT `+nodeColumns+` FROM providerNodes ORDER BY rowid`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		n, err := scanNode(rows.Scan)
		if err != nil {
			return err
		}
		s.Nodes[n.ID] = n
		s.NodeOrder = append(s.NodeOrder, n.ID)
	}
	return rows.Err()
}

func loadAPIKeys(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	rows, err := tx.QueryContext(ctx, `SELECT `+apiKeyColumns+` FROM apiKeys ORDER BY createdAt ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		k, err := scanAPIKey(rows.Scan)
		if err != nil {
			return err
		}
		s.APIKeys[k.Key] = k
	}
	return rows.Err()
}

// loadKV reads the three kv scopes with kvStore.js's getAll query, so rows
// come back in the order Node's object is built in.
func loadKV(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	custom := jsjson.NewObject()
	into := map[string]*jsjson.Object{"modelAliases": s.ModelAliases, "pricing": s.Pricing, "customModels": custom}
	for _, name := range Built.KVScopes {
		target := into[name]
		if target == nil {
			return fmt.Errorf("db: manifest kv scope %q has no snapshot field", name)
		}
		rows, err := tx.QueryContext(ctx, `SELECT key, value FROM kv WHERE scope = ?`, name)
		if err != nil {
			return err
		}
		for rows.Next() {
			var key string
			var value sql.NullString
			if err := rows.Scan(&key, &value); err != nil {
				_ = rows.Close()
				return err
			}
			// parseJson(r.value): unreadable is null.
			target.Set(key, parseJSONOr(value, nil))
		}
		// A scan cut short by an error must not pass as the whole scope.
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	// getCustomModels: Object.values(getAll()).
	s.CustomModels = []any{}
	for _, m := range custom.Members() {
		s.CustomModels = append(s.CustomModels, m.Value)
	}
	return nil
}

// Nodes is getProviderNodes(): every node, in table order.
func (d *DB) Nodes(ctx context.Context) ([]*ProviderNode, error) {
	rows, err := d.readers.QueryContext(ctx, `SELECT `+nodeColumns+` FROM providerNodes ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ProviderNode
	for rows.Next() {
		n, err := scanNode(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// NodeByID reads one provider node fresh (getProviderNodeById).
func (d *DB) NodeByID(ctx context.Context, id string) (*ProviderNode, error) {
	row := d.readers.QueryRowContext(ctx, `SELECT `+nodeColumns+` FROM providerNodes WHERE id = ?`, id)
	n, err := scanNode(row.Scan)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return n, err
}
