package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Connection is connectionsRepo.js's rowToConn: the columns, and Data, the
// data JSON with every other field (locks, keys, providerSpecificData).
type Connection struct {
	ID        string
	Provider  string
	AuthType  string
	Name      *string
	Email     *string
	Priority  any // the column as stored: nil, int64 or float64
	IsActive  bool
	CreatedAt string
	UpdatedAt string
	Data      *jsjson.Object
}

// Field is a key of the connection's data.
func (c *Connection) Field(key string) (any, bool) { return c.Data.Get(key) }

// String is a data key when it is a string, else "".
func (c *Connection) String(key string) string {
	v, _ := c.Data.Get(key)
	s, _ := v.(string)
	return s
}

// ProviderSpecificData is the connection's providerSpecificData object (nil when unset).
func (c *Connection) ProviderSpecificData() *jsjson.Object {
	v, _ := c.Data.Get("providerSpecificData")
	o, _ := v.(*jsjson.Object)
	return o
}

// sortPriority is `c.priority || 999`.
func (c *Connection) sortPriority() float64 {
	if n, ok := sqlNumber(c.Priority); ok && n != 0 {
		return n
	}
	return 999
}

// connColumnKeys are the columns connToRow keeps out of data.
var connColumnKeys = []string{"id", "provider", "authType", "name", "email", "priority", "isActive", "createdAt", "updatedAt"}

const connColumns = `id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt`

func scanConn(scan func(...any) error) (*Connection, error) {
	var (
		c                         Connection
		name, email, data, cr, up sql.NullString
		authType                  sql.NullString
		isActive                  any
	)
	if err := scan(&c.ID, &c.Provider, &authType, &name, &email, &c.Priority, &isActive, &data, &cr, &up); err != nil {
		return nil, err
	}
	c.AuthType = authType.String
	c.Name, c.Email = nullString(name), nullString(email)
	c.IsActive = isTrue1(isActive)
	c.CreatedAt, c.UpdatedAt = cr.String, up.String
	c.Data = stripKeys(parseObjectOr(data), connColumnKeys...)
	return &c, nil
}

// ListConnections is getProviderConnections({ provider, isActive }): an
// empty provider lists every provider, a nil active both states. Sorted as
// Node sorts (priority, 999 when unset; ties keep table order).
func (d *DB) ListConnections(ctx context.Context, provider string, active *bool) ([]*Connection, error) {
	where, args := []string{}, []any{}
	if provider != "" {
		where, args = append(where, "provider = ?"), append(args, provider)
	}
	if active != nil {
		v := 0
		if *active {
			v = 1
		}
		where, args = append(where, "isActive = ?"), append(args, v)
	}
	q := `SELECT ` + connColumns + ` FROM providerConnections`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	// Node has no ORDER BY; its plans (an equality index, or the table) all
	// return rowid order, which this makes explicit.
	q += " ORDER BY rowid"
	rows, err := d.readers.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []*Connection
	for rows.Next() {
		c, err := scanConn(rows.Scan)
		if err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].sortPriority() < list[j].sortPriority() })
	return list, nil
}

// ConnectionByID is getProviderConnectionById(id), read fresh. Nil when there is none.
func (d *DB) ConnectionByID(ctx context.Context, id string) (*Connection, error) {
	c, err := scanConn(d.readers.QueryRowContext(ctx, `SELECT `+connColumns+` FROM providerConnections WHERE id = ?`, id).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return c, err
}

// Gateway-owned connection fields (docs/GO_GATEWAY.md, the providerConnections
// row): what ConnectionUpdate.Set may write. authDemote_* records go through
// Demote and LiftDemote, authDemoteOkAt through NoteServed, and the turn-off
// fields through AutoDisable.
var (
	ownedPrefixes = []string{"modelLock_", "modelLimit_", "modelNoHeaders_", "providerReset_"}
	ownedFields   = map[string]bool{
		"backoffLevel": true, "lastError": true, "lastErrorAt": true, "errorCode": true, "testStatus": true,
		"lastUsedAt": true, "consecutiveUseCount": true,
	}
	// authStreakFields is connectionsRepo.js's AUTH_STREAK_FIELDS.
	authStreakFields = []string{
		"authFailCount", "authFailFirstAt", "authFailLastAt", "authFailModels", "authFailAll401", "authFailSameUpstream",
		"authFailRunCount", "authFailRunStartAt", "authFailBursts",
	}
)

// AuthDemotePrefix is connectionStatus.js's DEMOTE_PREFIX.
const AuthDemotePrefix = "authDemote_"

// OwnedField reports whether ConnectionUpdate.Set may write key.
func OwnedField(key string) bool {
	if ownedFields[key] {
		return true
	}
	for _, f := range authStreakFields {
		if key == f {
			return true
		}
	}
	for _, p := range ownedPrefixes {
		if strings.HasPrefix(key, p) && len(key) > len(p) {
			return true
		}
	}
	return false
}

// AutoDisable turns a dead key off: isActive false with when and why, only
// while another connection of its provider is on (decided in the write).
type AutoDisable struct {
	At     string
	Reason string
}

// Demote replaces the model's demotion record From with To, applies Data,
// and makes the demotions on the ProbeNow models due, only if the stored
// record still stringifies as From (Node's compare-and-swap).
type Demote struct {
	Model    string
	From, To any
	Data     []jsjson.Member
	ProbeNow []string
}

// ConnectionUpdate is updateProviderConnection(id, data, options) for the
// options the hot path uses. Set is `data`, applied in order over the stored
// fields ({...existing, ...data}); a nil value writes null, as Node's clears do.
type ConnectionUpdate struct {
	Set         []jsjson.Member
	AutoDisable *AutoDisable
	Demote      *Demote
	LiftDemote  string
	NoteServed  bool
	// APIKeyUsed is the key a failing request used (nil: not given). When
	// another key was stored since, the auth streak fields, AutoDisable and
	// Demote are dropped.
	APIKeyUsed *string
}

// ErrNotOwned is returned for a ConnectionUpdate that writes a field the
// gateway doesn't own.
var ErrNotOwned = errors.New("db: not a gateway-owned connection field")

// UpdateConnection applies u in one BEGIN IMMEDIATE transaction over the row
// as it is now, exactly as updateProviderConnection merges it, and returns
// the result (nil when there is no such row). Only the data, isActive and
// updatedAt columns change, and in data only what u names.
func (d *DB) UpdateConnection(ctx context.Context, id string, u ConnectionUpdate) (*Connection, error) {
	for _, m := range u.Set {
		if !OwnedField(m.Key) {
			return nil, fmt.Errorf("%w: %q", ErrNotOwned, m.Key)
		}
	}
	if u.Demote != nil {
		for _, m := range u.Demote.Data {
			if !OwnedField(m.Key) {
				return nil, fmt.Errorf("%w: %q", ErrNotOwned, m.Key)
			}
		}
	}
	var result *Connection
	err := d.writeTx(ctx, func(tx *sql.Tx) error {
		existing, err := scanConn(tx.QueryRowContext(ctx, `SELECT `+connColumns+` FROM providerConnections WHERE id = ?`, id).Scan)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		now := ISOTime(d.now())
		merged := existing.Data.Clone()
		isActive := existing.IsActive
		for _, m := range u.Set {
			merged.Set(m.Key, jsjson.CloneValue(m.Value))
		}
		staleKey := u.APIKeyUsed != nil && !strictEqual(get(existing.Data, "apiKey"), *u.APIKeyUsed)
		if staleKey {
			for _, f := range authStreakFields {
				if v, ok := existing.Data.Get(f); ok {
					merged.Set(f, jsjson.CloneValue(v))
				} else {
					merged.Delete(f)
				}
			}
		}
		if u.AutoDisable != nil && !staleKey && existing.IsActive {
			var one int
			err := tx.QueryRowContext(ctx, `SELECT 1 FROM providerConnections WHERE provider = ? AND id != ? AND isActive = 1 LIMIT 1`, existing.Provider, id).Scan(&one)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil {
				isActive = false
				merged.Set("autoDisabledAt", u.AutoDisable.At)
				merged.Set("autoDisabledReason", u.AutoDisable.Reason)
			}
		}
		if dm := u.Demote; dm != nil && !staleKey {
			key := AuthDemotePrefix + dm.Model
			stored, _ := existing.Data.Get(key)
			if jsjson.Equal(stored, dm.From) {
				for _, m := range dm.Data {
					merged.Set(m.Key, jsjson.CloneValue(m.Value))
				}
				merged.Set(key, jsjson.CloneValue(dm.To))
				for _, model := range dm.ProbeNow {
					rec, _ := existing.Data.Get(AuthDemotePrefix + model)
					o, ok := rec.(*jsjson.Object)
					if !ok {
						continue
					}
					demotedAt, _ := o.Get("demotedAt")
					next, _ := o.Get("nextProbeAt")
					// record?.demotedAt && record.nextProbeAt > now: a string compare.
					if nextStr, isStr := next.(string); jsjson.Truthy(demotedAt) && isStr && nextStr > now {
						c := o.Clone()
						c.Set("nextProbeAt", now)
						merged.Set(AuthDemotePrefix+model, c)
					}
				}
			}
		}
		if u.LiftDemote != "" {
			if v, _ := existing.Data.Get(AuthDemotePrefix + u.LiftDemote); jsjson.Truthy(v) {
				merged.Set(AuthDemotePrefix+u.LiftDemote, nil)
			}
		}
		if u.NoteServed {
			merged.Set("authDemoteOkAt", now)
		}
		stripKeys(merged, connColumnKeys...)

		bump := isActive != existing.IsActive
		if _, err := tx.ExecContext(ctx, `UPDATE providerConnections SET isActive = ?, data = ?, updatedAt = ? WHERE id = ?`,
			boolInt(isActive), merged.String(), now, id); err != nil {
			return err
		}
		if bump {
			if err := bumpConfigGeneration(ctx, tx); err != nil {
				return err
			}
		}
		out := *existing
		out.IsActive, out.UpdatedAt, out.Data = isActive, now, merged
		result = &out
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func get(o *jsjson.Object, key string) any {
	v, _ := o.Get(key)
	return v
}

// strictEqual is `a !== b` negated, for a stored value against a string.
func strictEqual(stored any, s string) bool {
	str, ok := stored.(string)
	return ok && str == s
}

// flagRE is nodeQuirks.ts's FLAG_RE (ASCII only: the regex has no u flag).
var flagRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$`)

// unionDroppedBetas is chat.ts's union(a, b): the flags of both, as
// sanitizeNodeQuirks keeps them (String, trim, valid names, first 50, deduped).
func unionDroppedBetas(a any, b []string) []any {
	var all []any
	if list, ok := a.([]any); ok {
		all = append(all, list...)
	}
	for _, s := range b {
		all = append(all, s)
	}
	seen := map[string]bool{}
	out := []any{}
	for _, f := range all {
		s := jsTrim(jsString(f))
		if !flagRE.MatchString(s) || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
		if len(out) == 50 {
			break
		}
	}
	return out
}

// MergeDroppedBetas is chat.ts's saveDroppedBetas for the rows: the beta
// flags an endpoint rejected, unioned into the connection's
// providerSpecificData.droppedBetas and, unless the request's credentials
// had their own endpoint (ownBaseURL), into the node's droppedBetas. Each row
// is re-read in its own transaction and only droppedBetas changes.
// connectionID or nodeID may be empty.
func (d *DB) MergeDroppedBetas(ctx context.Context, connectionID, nodeID string, betas []string, ownBaseURL bool) error {
	if connectionID != "" {
		err := d.writeTx(ctx, func(tx *sql.Tx) error {
			c, err := scanConn(tx.QueryRowContext(ctx, `SELECT `+connColumns+` FROM providerConnections WHERE id = ?`, connectionID).Scan)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			before, _ := c.Data.Get("providerSpecificData")
			psd := objectOrNew(jsjson.CloneValue(before))
			old, _ := psd.Get("droppedBetas")
			psd.Set("droppedBetas", unionDroppedBetas(old, betas))
			merged := c.Data.Clone()
			merged.Set("providerSpecificData", psd)
			stripKeys(merged, connColumnKeys...)
			if _, err := tx.ExecContext(ctx, `UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?`,
				merged.String(), ISOTime(d.now()), connectionID); err != nil {
				return err
			}
			// A dashboard-visible change, as updateProviderConnection classifies it.
			if !jsjson.Equal(before, psd) {
				return bumpConfigGeneration(ctx, tx)
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if nodeID == "" || ownBaseURL {
		return nil
	}
	return d.writeTx(ctx, func(tx *sql.Tx) error {
		n, err := scanNode(tx.QueryRowContext(ctx, `SELECT id, type, name, data, createdAt, updatedAt FROM providerNodes WHERE id = ?`, nodeID).Scan)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		old, _ := n.Data.Get("droppedBetas")
		n.Data.Set("droppedBetas", unionDroppedBetas(old, betas))
		if _, err := tx.ExecContext(ctx, `UPDATE providerNodes SET data = ?, updatedAt = ? WHERE id = ?`,
			n.Data.String(), ISOTime(d.now()), nodeID); err != nil {
			return err
		}
		// Every providerNodes write bumps the generation (nodesRepo.js).
		return bumpConfigGeneration(ctx, tx)
	})
}
