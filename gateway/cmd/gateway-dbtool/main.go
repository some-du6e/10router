// Command gateway-dbtool runs gateway/internal/db against a database file
// Node made, for CI (.github/workflows/gateway-db.yml). It is not shipped.
//
//	gateway-dbtool check  --db FILE              the schema guard; exit 3 when native would be off
//	gateway-dbtool dump   --db FILE              what the Go readers read, as Node's repos shape it
//	gateway-dbtool apply  --db FILE --ops F      run the writes in F (JSON) and print their results
//	gateway-dbtool stress --db FILE ...          hammer the file alongside Node, print a JSON summary
//	gateway-dbtool bench  --db FILE ...          time the hot-path queries
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/some-du6e/10router/gateway/internal/db"
	"github.com/some-du6e/10router/gateway/internal/db/jsjson"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: gateway-dbtool check|dump|apply|stress|bench --db FILE ...")
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var err error
	switch cmd {
	case "check":
		err = runCheck(args)
	case "dump":
		err = runDump(args)
	case "apply":
		err = runApply(args)
	case "stress":
		err = runStress(args)
	case "bench":
		err = runBench(args)
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		if e, ok := err.(exitError); ok {
			os.Exit(int(e))
		}
		fmt.Fprintln(os.Stderr, "gateway-dbtool:", err)
		os.Exit(1)
	}
}

type exitError int

func (e exitError) Error() string { return fmt.Sprintf("exit %d", int(e)) }

func openDB(path, now string) (*db.DB, error) {
	o := db.Options{}
	if now != "" {
		t, err := time.Parse(time.RFC3339Nano, now)
		if err != nil {
			return nil, fmt.Errorf("--now: %w", err)
		}
		o.Now = func() time.Time { return t }
	}
	return db.Open(path, o)
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func runCheck(args []string) error {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	path := fs.String("db", "", "database file")
	_ = fs.Parse(args)
	d, err := openDB(*path, "")
	if err != nil {
		printJSON(db.Status{Reason: "cannot open the database: " + err.Error()})
		return exitError(3)
	}
	defer d.Close()
	st := d.Check(context.Background())
	printJSON(st)
	if !st.Ready {
		return exitError(3)
	}
	return nil
}

func runDump(args []string) error {
	fs := flag.NewFlagSet("dump", flag.ExitOnError)
	path := fs.String("db", "", "database file")
	pools := fs.String("pools", "", "comma-separated proxy pool ids to read")
	_ = fs.Parse(args)
	ctx := context.Background()
	d, err := openDB(*path, "")
	if err != nil {
		return err
	}
	defer d.Close()
	snap, err := d.LoadSnapshot(ctx)
	if err != nil {
		return err
	}
	out := jsjson.NewObject()
	out.Set("generation", float64(snap.Generation))
	out.Set("settings", snap.Settings.Merged)

	combos := jsjson.NewObject()
	for name, c := range snap.Combos {
		combos.Set(name, c.NodeObject())
	}
	out.Set("combos", combos)

	nodes, err := d.Nodes(ctx)
	if err != nil {
		return err
	}
	nodeList := []any{}
	for _, n := range nodes {
		nodeList = append(nodeList, n.NodeObject())
	}
	out.Set("nodes", nodeList)

	keys, err := d.APIKeys(ctx)
	if err != nil {
		return err
	}
	keyList := []any{}
	for _, k := range keys {
		keyList = append(keyList, k.NodeObject())
	}
	out.Set("apiKeys", keyList)
	// The snapshot's copy of each key must be the same row.
	for _, k := range keys {
		if s := snap.APIKeys[k.Key]; s == nil || s.NodeObject().String() != k.NodeObject().String() {
			return fmt.Errorf("snapshot key %s differs from a fresh read", k.ID)
		}
	}

	out.Set("modelAliases", snap.ModelAliases)
	out.Set("pricing", snap.Pricing)
	out.Set("customModels", snap.CustomModels)

	conns, err := d.ListConnections(ctx, "", nil)
	if err != nil {
		return err
	}
	connList := []any{}
	for _, c := range conns {
		connList = append(connList, c.NodeObject())
	}
	out.Set("connections", connList)

	poolList := []any{}
	if *pools != "" {
		for _, id := range splitComma(*pools) {
			p, err := d.ProxyPoolByID(ctx, id)
			if err != nil {
				return err
			}
			if p == nil {
				poolList = append(poolList, nil)
			} else {
				poolList = append(poolList, p.NodeObject())
			}
		}
	}
	out.Set("proxyPools", poolList)
	_, _ = os.Stdout.Write(append(jsjson.Marshal(out), '\n'))
	return nil
}

func splitComma(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	return out
}

// ── apply ────────────────────────────────────────────────────────────────

func get(o *jsjson.Object, key string) any {
	v, _ := o.Get(key)
	return v
}

func str(o *jsjson.Object, key string) string {
	s, _ := get(o, key).(string)
	return s
}

func object(o *jsjson.Object, key string) *jsjson.Object {
	v, _ := get(o, key).(*jsjson.Object)
	return v
}

func list(o *jsjson.Object, key string) []any {
	v, _ := get(o, key).([]any)
	return v
}

func members(o *jsjson.Object) []jsjson.Member {
	if o == nil {
		return nil
	}
	return append([]jsjson.Member(nil), o.Members()...)
}

func stringList(vs []any) []string {
	var out []string
	for _, v := range vs {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func runApply(args []string) error {
	fs := flag.NewFlagSet("apply", flag.ExitOnError)
	path := fs.String("db", "", "database file")
	opsFile := fs.String("ops", "", "JSON array of writes")
	now := fs.String("now", "", "the clock, an ISO time")
	_ = fs.Parse(args)
	raw, err := os.ReadFile(*opsFile)
	if err != nil {
		return err
	}
	parsed, err := jsjson.Parse(raw)
	if err != nil {
		return err
	}
	ops, ok := parsed.([]any)
	if !ok {
		return fmt.Errorf("--ops is not an array")
	}
	d, err := openDB(*path, *now)
	if err != nil {
		return err
	}
	defer d.Close()
	ctx := context.Background()
	results := []any{}
	for i, v := range ops {
		op, ok := v.(*jsjson.Object)
		if !ok {
			return fmt.Errorf("op %d is not an object", i)
		}
		res, err := applyOne(ctx, d, op)
		if err != nil {
			return fmt.Errorf("op %d (%s): %w", i, str(op, "op"), err)
		}
		results = append(results, res)
	}
	_, _ = os.Stdout.Write(append(jsjson.Marshal(results), '\n'))
	return nil
}

func applyOne(ctx context.Context, d *db.DB, op *jsjson.Object) (any, error) {
	switch str(op, "op") {
	case "usage":
		var entries []db.UsageEntry
		for _, e := range list(op, "entries") {
			o, _ := e.(*jsjson.Object)
			cost, _ := get(o, "cost").(float64)
			entries = append(entries, db.UsageEntry{
				Timestamp: str(o, "timestamp"), Provider: str(o, "provider"), Model: str(o, "model"),
				ConnectionID: str(o, "connectionId"), APIKey: str(o, "apiKey"), Endpoint: str(o, "endpoint"),
				Tokens: object(o, "tokens"), Cost: cost, Status: str(o, "status"),
			})
		}
		return nil, d.WriteUsage(ctx, entries)
	case "connection":
		u := db.ConnectionUpdate{Set: members(object(op, "set")), LiftDemote: str(op, "liftDemote")}
		u.NoteServed, _ = get(op, "noteServed").(bool)
		if a := object(op, "autoDisable"); a != nil {
			u.AutoDisable = &db.AutoDisable{At: str(a, "at"), Reason: str(a, "reason")}
		}
		if dm := object(op, "demote"); dm != nil {
			u.Demote = &db.Demote{Model: str(dm, "model"), From: get(dm, "from"), To: get(dm, "to"),
				Data: members(object(dm, "data")), ProbeNow: stringList(list(dm, "probeNow"))}
		}
		if v, ok := op.Get("apiKeyUsed"); ok {
			s, _ := v.(string)
			u.APIKeyUsed = &s
		}
		c, err := d.UpdateConnection(ctx, str(op, "id"), u)
		if err != nil || c == nil {
			return nil, err
		}
		return c.NodeObject(), nil
	case "requestDetails":
		var rows []db.RequestDetail
		for _, e := range list(op, "rows") {
			o, _ := e.(*jsjson.Object)
			r := db.RequestDetail{
				ID: str(o, "id"), Timestamp: str(o, "timestamp"), Provider: str(o, "provider"), Model: str(o, "model"),
				ConnectionID: str(o, "connectionId"), Status: str(o, "status"),
				Latency: object(o, "latency"), Tokens: object(o, "tokens"),
				Request: get(o, "request"), ProviderRequest: get(o, "providerRequest"),
				ProviderResponse: get(o, "providerResponse"), Response: get(o, "response"),
				ErrorClass: str(o, "errorClass"),
			}
			if b := str(o, "fullDataBase64"); b != "" {
				full, err := base64.StdEncoding.DecodeString(b)
				if err != nil {
					return nil, err
				}
				r.FullData = full
			}
			rows = append(rows, r)
		}
		maxRecords, _ := get(op, "maxRecords").(float64)
		return nil, d.SaveRequestDetails(ctx, rows, int(maxRecords))
	case "droppedBetas":
		own, _ := get(op, "ownBaseUrl").(bool)
		return nil, d.MergeDroppedBetas(ctx, str(op, "connectionId"), str(op, "nodeId"), stringList(list(op, "betas")), own)
	}
	return nil, fmt.Errorf("unknown op")
}
