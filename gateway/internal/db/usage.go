package db

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

// UsageEntry is one request's usage row, the entry usageRepo.js's
// saveRequestUsage takes once it has priced it. An empty string is a field
// Node would have left undefined.
type UsageEntry struct {
	// Timestamp is an ISO time (ISOTime); its local date picks the usageDaily row.
	Timestamp    string
	Provider     string
	Model        string
	ConnectionID string
	APIKey       string
	Endpoint     string
	// Tokens is the usage object (prompt_tokens, input_tokens, ...). Counts
	// must be numbers. Nil is {}.
	Tokens *jsjson.Object
	// Cost in USD, already priced (internal/usage).
	Cost float64
	// Status is "ok" when empty.
	Status string
}

// costOr0 is `entry.cost || 0`.
func costOr0(c float64) float64 {
	if c != c {
		return 0
	}
	return c
}

func orNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// WriteUsage writes entries in one BEGIN IMMEDIATE transaction, with the
// result saveRequestUsage gives for them one after another: each one's
// usageHistory row and apiKeys spend, each day's usageDaily aggregate read
// once and written once, and _meta.totalRequestsLifetime moved by their count.
func (d *DB) WriteUsage(ctx context.Context, entries []UsageEntry) error {
	if len(entries) == 0 {
		return nil
	}
	return d.writeTx(ctx, func(ctx context.Context, tx *sql.Tx) error {
		insert, err := tx.PrepareContext(ctx, `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		defer insert.Close()
		spend, err := tx.PrepareContext(ctx, `UPDATE apiKeys SET spentUsd = COALESCE(spentUsd, 0) + ?, requestCount = COALESCE(requestCount, 0) + 1,
       lastUsedAt = CASE WHEN lastUsedAt IS NULL OR lastUsedAt < ? THEN ? ELSE lastUsedAt END
     WHERE key = ?`)
		if err != nil {
			return err
		}
		defer spend.Close()

		days := map[string]*jsjson.Object{}
		var dayOrder []string
		for i := range entries {
			e := &entries[i]
			tokens := e.Tokens
			if tokens == nil {
				tokens = jsjson.NewObject()
			}
			status := e.Status
			if status == "" {
				status = "ok"
			}
			// `if (!entry.timestamp) entry.timestamp = new Date().toISOString()`
			ts := e.Timestamp
			if ts == "" {
				ts = ISOTime(d.now())
			}
			tc := countTokens(tokens)
			if _, err := insert.ExecContext(ctx, ts, orNull(e.Provider), orNull(e.Model), orNull(e.ConnectionID),
				orNull(e.APIKey), orNull(e.Endpoint), tc.prompt, tc.completion, costOr0(e.Cost), status,
				tokens.String(), "{}"); err != nil {
				return err
			}

			dateKey := localDateKey(ts)
			day, ok := days[dateKey]
			if !ok {
				var data sql.NullString
				err := tx.QueryRowContext(ctx, `SELECT data FROM usageDaily WHERE dateKey = ?`, dateKey).Scan(&data)
				switch {
				case errors.Is(err, sql.ErrNoRows):
					day = newDay()
				case err != nil:
					return err
				default:
					// parseJson(row.data, {}); a row that isn't an object
					// (Node would throw on it and lose the request's usage)
					// starts over.
					day = parseObjectOr(data)
				}
				days[dateKey] = day
				dayOrder = append(dayOrder, dateKey)
			}
			aggregateEntryToDay(day, e, tc)

			// addApiKeySpendSync: a key that isn't in apiKeys updates nothing.
			if e.APIKey != "" {
				if _, err := spend.ExecContext(ctx, costOr0(e.Cost), ts, ts, e.APIKey); err != nil {
					return err
				}
			}
		}
		for _, dateKey := range dayOrder {
			if _, err := tx.ExecContext(ctx, `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
				dateKey, days[dateKey].String()); err != nil {
				return err
			}
		}
		return addLifetimeRequests(ctx, tx, len(entries))
	})
}

// addLifetimeRequests is saveRequestUsage's counter, n times over:
// String(parseInt(value, 10) + 1), so a value parseInt can't read stays "NaN".
func addLifetimeRequests(ctx context.Context, tx *sql.Tx, n int) error {
	var cur sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`).Scan(&cur)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	next := "NaN"
	if errors.Is(err, sql.ErrNoRows) {
		next = jsNumberString(float64(n))
	} else if v, ok := jsParseIntOK(cur.String); ok {
		next = jsNumberString(float64(v) + float64(n))
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, next)
	return err
}

// newDay is the object saveRequestUsage starts a day with.
func newDay() *jsjson.Object {
	o := jsjson.NewObject()
	for _, k := range []string{"requests", "promptTokens", "completionTokens", "cost"} {
		o.Set(k, 0.0)
	}
	for _, k := range []string{"byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"} {
		o.Set(k, jsjson.NewObject())
	}
	return o
}

// add is `day[key] = (day[key] || 0) + n`.
func add(o *jsjson.Object, key string, n float64) {
	v, _ := o.Get(key)
	o.Set(key, num(v)+n)
}

// child is `day[key] ||= {}`.
func child(o *jsjson.Object, key string) *jsjson.Object {
	v, _ := o.Get(key)
	if c, ok := v.(*jsjson.Object); ok && jsjson.Truthy(v) {
		return c
	}
	c := jsjson.NewObject()
	o.Set(key, c)
	return c
}

type counterValues struct {
	promptTokens, completionTokens, cachedTokens, cost float64
	// meta is Object.assign'd onto the counter; an absent{} value is
	// undefined there (the key is dropped), nil a stored null.
	meta []jsjson.Member
}

// absent marks a meta value that is undefined in JavaScript.
type absent struct{}

func metaValue(s string) any {
	if s == "" {
		return absent{}
	}
	return s
}

// addToCounter is usageRepo.js's addToCounter.
func addToCounter(target *jsjson.Object, key string, v counterValues) {
	cur, _ := target.Get(key)
	c, ok := cur.(*jsjson.Object)
	if !ok || !jsjson.Truthy(cur) {
		c = jsjson.NewObject()
		for _, k := range []string{"requests", "promptTokens", "completionTokens", "cachedTokens", "cost"} {
			c.Set(k, 0.0)
		}
		target.Set(key, c)
	}
	add(c, "requests", 1)
	add(c, "promptTokens", v.promptTokens)
	add(c, "completionTokens", v.completionTokens)
	add(c, "cachedTokens", v.cachedTokens)
	add(c, "cost", v.cost)
	for _, m := range v.meta {
		if _, undefined := m.Value.(absent); undefined {
			// JSON.stringify drops an undefined property, so the next read
			// doesn't have it.
			c.Delete(m.Key)
			continue
		}
		c.Set(m.Key, m.Value)
	}
}

type tokenCounts struct{ prompt, completion, cached float64 }

// countTokens is usageRepo.js's `tokens.prompt_tokens || tokens.input_tokens || 0` and the like.
func countTokens(tokens *jsjson.Object) tokenCounts {
	return tokenCounts{
		prompt:     num(firstTruthy(tokens, "prompt_tokens", "input_tokens")),
		completion: num(firstTruthy(tokens, "completion_tokens", "output_tokens")),
		cached:     num(firstTruthy(tokens, "cached_tokens", "cache_read_input_tokens")),
	}
}

// aggregateEntryToDay is usageRepo.js's aggregateEntryToDay.
func aggregateEntryToDay(day *jsjson.Object, e *UsageEntry, tc tokenCounts) {
	promptTokens, completionTokens, cachedTokens := tc.prompt, tc.completion, tc.cached
	cost := costOr0(e.Cost)

	add(day, "requests", 1)
	add(day, "promptTokens", promptTokens)
	add(day, "completionTokens", completionTokens)
	add(day, "cachedTokens", cachedTokens)
	add(day, "cost", cost)

	byProvider := child(day, "byProvider")
	byModel := child(day, "byModel")
	byAccount := child(day, "byAccount")
	byAPIKey := child(day, "byApiKey")
	byEndpoint := child(day, "byEndpoint")

	vals := counterValues{promptTokens: promptTokens, completionTokens: completionTokens, cachedTokens: cachedTokens, cost: cost}
	// `${entry.model}` of an undefined model is "undefined".
	model := e.Model
	if model == "" {
		model = "undefined"
	}
	if e.Provider != "" {
		addToCounter(byProvider, e.Provider, vals)
	}

	modelKey := model
	if e.Provider != "" {
		modelKey = model + "|" + e.Provider
	}
	withMeta := func(meta ...jsjson.Member) counterValues {
		v := vals
		v.meta = meta
		return v
	}
	rawModel := jsjson.Member{Key: "rawModel", Value: metaValue(e.Model)}
	provider := jsjson.Member{Key: "provider", Value: metaValue(e.Provider)}
	addToCounter(byModel, modelKey, withMeta(rawModel, provider))

	if e.ConnectionID != "" {
		addToCounter(byAccount, e.ConnectionID, withMeta(rawModel, provider))
	}

	apiKeyVal := e.APIKey
	if apiKeyVal == "" {
		apiKeyVal = "local-no-key"
	}
	providerOrUnknown := e.Provider
	if providerOrUnknown == "" {
		providerOrUnknown = "unknown"
	}
	addToCounter(byAPIKey, apiKeyVal+"|"+model+"|"+providerOrUnknown,
		withMeta(rawModel, provider, jsjson.Member{Key: "apiKey", Value: orNull(e.APIKey)}))

	endpoint := e.Endpoint
	if endpoint == "" {
		endpoint = "Unknown"
	}
	addToCounter(byEndpoint, endpoint+"|"+model+"|"+providerOrUnknown,
		withMeta(jsjson.Member{Key: "endpoint", Value: endpoint}, rawModel, provider))
}

// UsageWriterOptions configure a UsageWriter.
type UsageWriterOptions struct {
	// Interval between flushes (100 ms when 0).
	Interval time.Duration
	// MaxBatch rows per transaction (500 when 0).
	MaxBatch int
	// MaxQueued rows held while the database is unavailable (50,000 when 0).
	// Past it the oldest rows are dropped and counted.
	MaxQueued int
	// OnError is called with each failed flush (its rows stay queued).
	OnError func(error)
}

// UsageWriter batches usage rows: Add queues one, and every Interval the
// queue is written in writes of up to MaxBatch rows, which the writer
// (writer.go) puts in as few transactions as it can.
type UsageWriter struct {
	d    *DB
	opts UsageWriterOptions

	mu      sync.Mutex
	queue   []UsageEntry
	dropped int64
	written int64

	flushMu   sync.Mutex
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

// NewUsageWriter starts a writer. Close flushes what is left.
func (d *DB) NewUsageWriter(o UsageWriterOptions) *UsageWriter {
	if o.Interval <= 0 {
		o.Interval = 100 * time.Millisecond
	}
	if o.MaxBatch <= 0 {
		o.MaxBatch = 500
	}
	if o.MaxQueued <= 0 {
		o.MaxQueued = 50000
	}
	w := &UsageWriter{d: d, opts: o, stop: make(chan struct{}), done: make(chan struct{})}
	go w.loop()
	return w
}

// Add queues one row.
func (w *UsageWriter) Add(e UsageEntry) {
	w.mu.Lock()
	w.queue = append(w.queue, e)
	if over := len(w.queue) - w.opts.MaxQueued; over > 0 {
		// Re-slicing, not copying: the backing array is let go on the next
		// growth, so a full queue costs nothing per row.
		w.queue = w.queue[over:]
		w.dropped += int64(over)
	}
	w.mu.Unlock()
}

// Stats are the rows written, dropped and waiting.
func (w *UsageWriter) Stats() (written, dropped int64, queued int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.written, w.dropped, len(w.queue)
}

func (w *UsageWriter) loop() {
	defer close(w.done)
	t := time.NewTicker(w.opts.Interval)
	defer t.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			if err := w.Flush(context.Background()); err != nil && w.opts.OnError != nil {
				w.opts.OnError(err)
			}
		}
	}
}

// Flush writes everything queued now. A batch that fails goes back to the
// front of the queue.
func (w *UsageWriter) Flush(ctx context.Context) error {
	w.flushMu.Lock()
	defer w.flushMu.Unlock()
	for {
		w.mu.Lock()
		n := min(len(w.queue), w.opts.MaxBatch)
		batch := append([]UsageEntry(nil), w.queue[:n]...)
		droppedBefore := w.dropped
		w.mu.Unlock()
		if n == 0 {
			return nil
		}
		if err := w.d.WriteUsage(ctx, batch); err != nil {
			return err
		}
		w.mu.Lock()
		// Add only appends, or drops from the front past MaxQueued: what it
		// dropped meanwhile came off this batch first, and was written after all.
		droppedHere := min(n, int(w.dropped-droppedBefore))
		w.dropped -= int64(droppedHere)
		w.queue = w.queue[min(n-droppedHere, len(w.queue)):]
		w.written += int64(n)
		w.mu.Unlock()
	}
}

// Close stops the timer and writes what is left. Later calls only flush.
func (w *UsageWriter) Close(ctx context.Context) error {
	w.closeOnce.Do(func() {
		close(w.stop)
		<-w.done
	})
	return w.Flush(ctx)
}
