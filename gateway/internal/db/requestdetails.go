package db

import (
	"context"
	"database/sql"
	"math/rand/v2"
	"regexp"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// Request-detail limits from requestDetailsRepo.js.
const (
	// FullDataKeepRows is FULL_DATA_KEEP_ROWS: only the newest rows keep a full copy.
	FullDataKeepRows = 25
	// maxRowsPerWrite is MAX_ROWS_PER_WRITE.
	maxRowsPerWrite = 200
	// DefaultMaxRecords is DEFAULT_MAX_RECORDS.
	DefaultMaxRecords = 200
)

// RequestDetail is one requestDetails row as requestDetailsRepo.js's
// buildSave makes it. The payloads are already capped (internal/usage does
// what truncateField does); a nil payload is stored as {}, as there.
type RequestDetail struct {
	ID           string
	Timestamp    string
	Provider     string
	Model        string
	ConnectionID string
	Status       string
	// Latency and Tokens are objects; nil is {}.
	Latency *jsjson.Object
	Tokens  *jsjson.Object

	Request, ProviderRequest, ProviderResponse, Response any
	// ErrorClass is left out of the record when empty.
	ErrorClass string
	// FullData is the gzipped full copy, or nil for none (the row keeps a
	// copy an earlier save of it stored).
	FullData []byte
}

func orObject(o *jsjson.Object) *jsjson.Object {
	if o == nil {
		return jsjson.NewObject()
	}
	return o
}

// orEmptyPayload is truncateField's `if (obj === undefined || obj === null) return {}`.
func orEmptyPayload(v any) any {
	if o, ok := v.(*jsjson.Object); v == nil || (ok && o == nil) {
		return jsjson.NewObject()
	}
	return v
}

var notIDChar = regexp.MustCompile(`[^a-zA-Z0-9-]`)

// detailID is requestDetailsRepo.js's generateDetailId:
// `${now}-${6 random base-36 chars}-${model with other chars as "-"}`, now
// being the time the id is made (not the row's timestamp), as there.
func detailID(now, model string) string {
	timestamp := now
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	random := make([]byte, 6)
	for i := range random {
		random[i] = digits[rand.IntN(len(digits))]
	}
	modelPart := "unknown"
	if model != "" {
		modelPart = notIDChar.ReplaceAllString(model, "-")
	}
	return timestamp + "-" + string(random) + "-" + modelPart
}

// Record is the JSON stored in the row's data column, in buildSave's key order.
func (r *RequestDetail) Record() *jsjson.Object {
	o := jsjson.NewObject()
	o.Set("id", r.ID)
	o.Set("provider", orNull(r.Provider))
	o.Set("model", orNull(r.Model))
	o.Set("connectionId", orNull(r.ConnectionID))
	o.Set("timestamp", r.Timestamp)
	o.Set("status", orNull(r.Status))
	o.Set("latency", orObject(r.Latency))
	o.Set("tokens", orObject(r.Tokens))
	o.Set("request", orEmptyPayload(r.Request))
	o.Set("providerRequest", orEmptyPayload(r.ProviderRequest))
	o.Set("providerResponse", orEmptyPayload(r.ProviderResponse))
	o.Set("response", orEmptyPayload(r.Response))
	if r.ErrorClass != "" {
		o.Set("errorClass", r.ErrorClass)
	}
	return o
}

const upsertRequestDetailSQL = `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, fullData) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data, fullData = COALESCE(excluded.fullData, requestDetails.fullData)`

// SaveRequestDetails is requestDetailsRepo.js's batch write: each row
// upserted, full copies kept on the newest FullDataKeepRows rows only, and the
// table trimmed to maxRecords (the observabilityMaxRecords setting; 0 or less
// is DefaultMaxRecords), in transactions of up to 200 rows.
func (d *DB) SaveRequestDetails(ctx context.Context, rows []RequestDetail, maxRecords int) error {
	if maxRecords <= 0 {
		maxRecords = DefaultMaxRecords
	}
	// buildSave's defaults, set in the caller's rows: rows over 200 go in
	// several transactions, and a caller retrying after an error that came
	// after some landed upserts the same ids instead of adding new rows.
	for i := range rows {
		if rows[i].Timestamp == "" {
			rows[i].Timestamp = ISOTime(d.now())
		}
		if rows[i].ID == "" {
			rows[i].ID = detailID(ISOTime(d.now()), rows[i].Model)
		}
	}
	for len(rows) > 0 {
		n := min(len(rows), maxRowsPerWrite)
		batch := rows[:n]
		rows = rows[n:]
		err := d.writeTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
			for i := range batch {
				r := &batch[i]
				var full any
				if r.FullData != nil {
					full = r.FullData
				}
				if _, err := tx.ExecContext(ctx, upsertRequestDetailSQL, r.ID, r.Timestamp, orNull(r.Provider), orNull(r.Model),
					orNull(r.ConnectionID), orNull(r.Status), r.Record().String(), full); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(ctx, `UPDATE requestDetails SET fullData = NULL WHERE fullData IS NOT NULL AND id NOT IN (SELECT id FROM requestDetails ORDER BY timestamp DESC, id DESC LIMIT ?)`,
				FullDataKeepRows); err != nil {
				return err
			}
			var count int64
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) as c FROM requestDetails`).Scan(&count); err != nil {
				return err
			}
			if count > int64(maxRecords) {
				if _, err := tx.ExecContext(ctx, `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
					count-int64(maxRecords)); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}
