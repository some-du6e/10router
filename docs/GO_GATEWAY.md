# Go gateway

A Go process in front of the Node app server. It takes over the hot inference path one route at a time and relays everything else to Node. Phase 1, this document's first deliverable, ships proxy mode only: the gateway relays every request and serves nothing itself. `GATEWAY_MODE=off` is the default, and with it the container runs exactly as before.

Why Go: all of Node's request handling (body parsing, rewriting, SSE relay) runs on one JS thread. On a busy install that one thread is what saturates first, however many cores the box has. The hot path parses 1 to 4 MB JSON bodies, rewrites them and relays SSE. Go can spread that over every core and allocate far less per request.

The code is in `gateway/`, a Go module. Phase 1 used only the standard library. Phase 2b adds the one planned dependency, `modernc.org/sqlite`, for `internal/db`.

## Process layout

One container, two processes.

```
client ──► :20128  10router-gateway  (PID 1, Go)
                     │  relays over loopback, peer handed over in headers
                     ▼
           127.0.0.1:20129  node custom-server.js  (child of the gateway)
                     │
                     ▼
           DATA_DIR/db/data.sqlite   (shared from phase 2; Node owns the schema)
```

- `scripts/docker-entrypoint.sh` fixes ownership of `/app/data` and `/app/data-home` as before. With `GATEWAY_MODE=proxy` or `native` it then runs `su-exec node /app/gateway/10router-gateway -- node custom-server.js`. Any other value, unset included, runs `su-exec node node custom-server.js`, which is what the old inline entrypoint did. An unknown value logs a warning and runs Node alone.
- The gateway listens on `HOSTNAME:PORT` (default `0.0.0.0:20128`, what Node used). An IPv4 address opens an IPv4-only socket, as Node's does. Go's plain `tcp` on `0.0.0.0` would also listen on IPv6.
- It starts the command with `PORT=$GATEWAY_APP_PORT` (default 20129), `HOSTNAME=127.0.0.1`, `KEEP_ALIVE_TIMEOUT=30000`, a fresh random `GATEWAY_PEER_TOKEN`, and `GATEWAY_MODE` set to the mode it parsed (`proxy` or `native`), so Node never reads the raw value its own way. The rest of the environment passes through unchanged.
- The gateway binds its port only after Node accepts connections, so a client during boot gets a refused connection, as it does today, instead of a 502.
- Node's stdout and stderr are the gateway's, so the container log is unchanged. Gateway lines start with `[Gateway]`.
- If Node exits on its own (a crash, an OOM restart, the updater), the gateway exits with the same code, so the restart policy sees what it sees today. A killed Node reports 128 plus the signal, the way a shell does.
- On Linux, Node gets `SIGKILL` if the gateway dies without stopping it (parent-death signal), so a crashed gateway can't leave a Node process holding the database.
- The data dir is still `.9router` and the compose volume is still `9router-data`.
- The gateway reaps only its own child. That matches today, where Node as PID 1 doesn't reap orphans either.
- Memory: the gateway's RSS is in the bench job's output. A container memory limit (cgroup `memory.max`), if there is one, now covers both processes.

`GATEWAY_MODE=off` leaves nothing of the gateway running. The entrypoint never starts it. If someone runs the binary with `off` anyway, it `exec`s the command in its own place.

## Modes and settings

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_MODE` | `off` | `off`: Node alone on `PORT`. `proxy`: the gateway relays everything. `native`: proxy plus the routes the gateway serves itself. This build has none, so it relays everything as `proxy` does and logs that. It also opens the database once Node listens, runs the schema guard and keeps the config snapshot current (see "Phase 2b"), which only the health endpoint and the log show. |
| `GATEWAY_APP_PORT` | `20129` | Node's loopback port. If it equals `PORT`, `PORT+1` is used. |
| `KEEP_ALIVE_TIMEOUT` | `5000` | The public idle keep-alive timeout, read the way Next's standalone `server.js` reads it: `parseInt`, and anything not positive leaves the default. |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `180000` | Parsed exactly like `server-drain.js` does. Both processes read it. |
| `TRUST_PROXY` | unset | Read by the client-IP rule, the same value Node reads. |
| `GATEWAY_PEER_TOKEN` | random | Leave it unset; the gateway makes one per boot and gives it to Node. A value under 32 characters stops the gateway from starting. custom-server.js acts on it only while `GATEWAY_MODE` is `proxy` or `native`, so a token left in an env file does nothing once the mode is back to `off`. |

The request-body timeout (300 s) and headers timeout (60 s) are Node's defaults, which nothing in this repo changes, so they are constants rather than settings. The header size cap follows Node's `--max-http-header-size`, from `NODE_OPTIONS` or the node command line (which wins).

The binary always starts Node itself (`10router-gateway -- node custom-server.js`) and refuses to run without a command. Relaying to a Node started some other way can't prove that both sides hold the token, and a Node without it would take every relayed client for a local one.

Phase 2 adds `GATEWAY_NATIVE_ROUTES` (for example `POST /v1/messages`) and `GATEWAY_NATIVE_PROVIDERS` (provider node ids or prefixes such as `openai-compatible-chat-*`). Both are allowlists: a request is native only if its route and every provider it could reach are listed. Everything else is proxied.

The fallback rule: when in doubt, proxy to Node. In phase 2 the gateway proxies whenever:

- the mode is `proxy`, or the route or provider isn't allowlisted;
- the database schema is newer than the gateway understands (see below), or Node runs on `sql.js`;
- the gateway hits anything it doesn't model yet: a setting it can't read, a combo strategy it doesn't port, an endpoint override it can't apply, a client format it doesn't parse.

It may hand a request to Node until the first response byte has gone to the client. It keeps the request body bytes, so the handoff replays them unchanged. After the first byte there is no handoff, and the gateway owns the error, exactly as Node does today.

## Proxy mode in detail

`gateway/internal/proxy` wraps `httputil.ReverseProxy`.

- **No buffering.** Request bodies stream to Node as they arrive, and `FlushInterval: -1` flushes every chunk Node writes. One SSE event goes out as one flush. A test holds back the second megabyte of a 4 MB body until the upstream reports it has the first, so a proxy that buffered would deadlock there.
- **Headers pass through.** That covers `Authorization`, `x-api-key`, `anthropic-beta` and everything else. `Host` is the client's, because Node's origin checks, tunnel detection and local-client rule read it. `ReverseProxy` drops `Forwarded`, `X-Forwarded-For`, `-Host` and `-Proto` before `Rewrite`, and any header a client names in `Connection`. The gateway puts every header in custom-server.js's `FORWARDING_HEADERS` back as the client sent it and adds none of its own, since Node's rule decides whose forwarding headers count. Node never honoured `Connection` tokens, so a client can't use them to strip a front proxy's `X-Real-IP`.
- **The request target is the client's.** `ReverseProxy` re-escapes the path (a `\`, which Node's URL parser reads as `/`, would arrive as `%5C`) and re-encodes a query that has a `;` or a bad `%` escape, which drops those parameters and sorts the rest. The gateway sends the original path and query. `OPTIONS *` goes to Node too, not to `net/http`'s built-in empty 200. Two exceptions: a path starting `//` keeps `ReverseProxy`'s escaping (sent raw it would read as an authority), and Go's server answers `400` to a path with a malformed `%` escape before the gateway sees it.
- **Header size.** The gateway caps a client's headers at about Node's `--max-http-header-size` (16 KiB, or whatever `NODE_OPTIONS` or the node command line sets), instead of Go's 1 MiB. It counts every raw byte where Node counts only names, values and the URL, so it is stricter by a few bytes per header. Behind the gateway, custom-server.js gives its server 4 KiB more than the flag, room for the peer headers, so the gateway is the one that answers `431`.
- **Header count.** Node takes 1000 header lines by default and can drop the rest without a word (versions differ, so the design doesn't count on a refusal). `net/http` writes headers sorted by name, so the peer headers go out near the end, where a dropping Node would lose them to a client's padding. The gateway answers `431` above 990 lines. Node also treats a gateway-less loopback request at its cap as `unknown`.
- **No content sniffing.** Go's server would guess a `Content-Type` for a reply Node sent without one. The gateway turns that off, so the header is Node's or absent.
- **Hop-by-hop headers stop at the gateway in both directions.** These are `Connection` and the headers it lists, `Keep-Alive`, `Proxy-Connection`, `TE` (except `trailers`), `Transfer-Encoding` and `Upgrade`. `Expect: 100-continue` is answered by the gateway and not sent on.
- **No transparent gzip.** The loopback transport has `DisableCompression`, so the client's own `Accept-Encoding` reaches Node untouched. Node compresses or doesn't, as before. The transport also ignores `HTTP_PROXY`, which 10router users set for upstream calls.
- **Timeouts are never shorter than Node's.** The gateway sets no write timeout and no response-header timeout, so streams can run 10 minutes and more. Node sends early SSE headers after 30 s and owns the 240 s upstream headers limit. The request-body bound runs as a read deadline that lifts as soon as the body has been read, so it never cuts a response. A body that misses it gets Node's bare `408` and the upstream request is cancelled.
- **Loopback pool.** Up to 256 idle connections to Node, idle timeout 20 s, with 32 KiB read and write buffers each (16 MiB if all 256 sit idle). Node's keep-alive on that hop is 30 s, so the gateway always closes an idle connection first and never sends a POST on a socket Node is closing at that moment. Such a POST could not be retried.
- **Client aborts.** A client that disconnects cancels the request context, the transport closes the connection to Node, and Node sees `close` and stops the upstream call. A test checks this end to end.
- **WebSocket.** `ReverseProxy` relays `Upgrade: websocket` and splices the two connections after Node's `101`. The Codex bridge runs in Node unchanged. `ReverseProxy` copies from the raw hijacked connection, so bytes a client sends right behind its upgrade request would stay in the server's read buffer and be lost. Codex sends its `response.create` frame that way, without waiting for the 101. The gateway hands `ReverseProxy` a connection that reads through that buffer first.
- **h2c.** custom-server.js serves an `Upgrade: h2c` request (JBR sends them) as the HTTP/1.1 request it also is, and closes the connection afterwards. The gateway does the same before relaying, so Node never sees the upgrade.
- **Node unreachable.** The gateway answers `502` with `{"error":{"code":"gateway_upstream_unavailable",...}}` and `Retry-After: 1`. If Node fails mid-stream, the gateway aborts the client connection, as a destroyed Node socket would.
- **Absolute-form request targets** (`POST http://host/v1/...`). The authority becomes `Host`, as RFC 9112 says it must. Node used the `Host` header instead, but no real client sends absolute-form to an origin server.

Next builds `request.url` from its own listen address and port, not the `Host` header. Behind the gateway that is `127.0.0.1:20129` instead of the 20128 address, so a route that takes an origin from `request.url` (SAML metadata without a base URL, for one) gets the loopback one. Neither is a public address, so set `BASE_URL` for those either way.

Header name casing on responses changes, because Go canonicalizes names. HTTP/1.1 header names are case-insensitive, and the e2e compares bodies, not header spelling.

## Client IP

custom-server.js decides who a request comes from. Forwarding headers count only from a loopback peer or a peer `TRUST_PROXY` lists, and every other peer is its socket address. Rate limits, the login limiter, keyless local `/v1` and audit logs all depend on that.

Behind the gateway, Node's TCP peer is always the gateway on loopback. Without help, every request would look local. So the gateway hands the real peer over:

- On every request it deletes any client copy of `x-9r-gw-token`, `x-9r-gw-peer-ip` and `x-9r-gw-peer-port`. It then sets them to its token and the address and port of the connection it accepted. An IPv4 client of an IPv6 listener is written `::ffff:a.b.c.d`, the spelling Node's socket would report.
- custom-server.js removes the three headers from every request. When `GATEWAY_PEER_TOKEN` is set, the socket is loopback, the token matches (constant-time compare) and the IP parses, it uses the handed peer in place of `req.socket.remoteAddress` for everything: `isOnThisMachine`, `clientKeysFor`, `isTunnelTraffic`, the `x-9r-socket-ip` and `-port` stamps, and the Codex WebSocket bridge's peer. The token leaves `process.env` at boot so Node's children don't inherit it. With `GATEWAY_MODE=off` the variable is unset and none of this code runs.
- It fails closed. A loopback request that carries any of the headers but can't prove them (wrong token, no token, a peer that isn't an address) gets the peer `unknown`, which is never this machine. Falling back to the socket would make it local, since behind the gateway the socket is always loopback. For the same reason the gateway refuses to start with a token shorter than 32 characters, or without a Node command of its own.
- A request that reaches Node's loopback port directly, from inside the container, carries none of the headers and is treated as it is today: a loopback client. That covers the Codex bridge's own POST and Node's self-calls.

The rule itself runs unchanged in Node. `gateway/internal/clientip` is a Go port of it (`isLoopbackHost`, `isOnThisMachine`, `clientKeysFor`, `isTrustedProxyPeer`, `isTunnelTraffic`), down to JavaScript quirks such as `Number("")` being 0 in a `TRUST_PROXY` prefix. In phase 1 it only decides who sees the health endpoint's counters. Phase 2's native routes use it. Both implementations are held to one table, `gateway/internal/clientip/testdata/parity.json`. `go test` reads it, and so does `tests/unit/gateway-clientip-parity.test.js` against custom-server.js. A rule change in one place fails the other until the table and both ports agree.

## Graceful drain and shutdown

The gateway follows `server-drain.js`, and Node runs its own drain alongside.

1. On the first `SIGTERM` or `SIGINT`, the gateway logs `[Gateway] SIGTERM: draining N in-flight request(s)...` and marks itself draining. It passes the signal on to Node 250 ms later, so a request it admitted just before has reached Node by the time Node closes its listener and idle connections.
2. `http.Server.Shutdown` closes the listener, so new connections are refused. It also closes each keep-alive connection as it goes idle.
3. A request that still arrives on an open connection gets the same `503` JSON body (`server_draining`), `Retry-After: 5` and `Connection: close`. An upgrade gets the bare `503`.
4. The never-ending dashboard streams (`/api/usage/stream`, the console-log stream, MCP SSE) close at once.
5. Model traffic holds the drain. The gateway counts it with the same path rule as `MODEL_TRAFFIC`, including dot segments, percent-decoding and absolute-form targets. The Go tests use the same cases as `tests/unit/server-drain.test.js`. WebSocket connections don't hold the gateway's drain. A Codex turn holds Node's drain, and the gateway waits for Node.
6. The gateway exits when its own model requests are done and Node has exited, after a 200 ms flush. It exits with Node's exit code.
7. A repeat signal soon after the first is the same stop arriving twice (`npm`, a supervisor and a `kill` can all send one). Node ignores a repeat within 1.5 s of the signal it got, and that one arrived 250 ms late, so the gateway ignores repeats within 1.75 s of its own. A later repeat goes on to Node, which then exits at once; the gateway gives it 2 s and exits 1.
8. The gateway's deadline is the drain timeout plus 3 s. Node's own timeout fires first, then its listeners get their 2 s. After that the gateway kills Node and exits 1.
9. `SHUTDOWN_DRAIN_TIMEOUT_MS=0` stops both at once, as before.
10. `SIGHUP`, `SIGQUIT`, `SIGABRT`, `SIGUSR2` and `SIGPIPE` are ignored. As PID 1 with no handler on them, Node ignored the first four too, because the kernel drops a default-action signal to a namespace's init. Go's runtime would otherwise exit on them with no drain, and passed on, their default action would kill Node, which is no longer PID 1. A broken log pipe must not end the gateway. `SIGUSR1` (Node's inspector) goes on to Node, unless Node runs with `--disable-sigusr1` (then it is ignored too). So does the signal of a heap-snapshot or diagnostic-report handler (`--heapsnapshot-signal`, or `--report-on-signal`/`--report-signal`, default `SIGUSR2`, in `NODE_OPTIONS` or on the command line) when it is `SIGUSR2`, `SIGHUP` or `SIGQUIT`.
11. Node runs in its own process group, so a terminal's signals (`docker run -it`) reach only the gateway. Ctrl-C drains as above. Ctrl-\ (`SIGQUIT`) follows item 10: ignored, unless a Node report or heap-snapshot handler is on it, as with Node as PID 1.

Docker's `stop_grace_period` must still exceed the drain timeout. The compose file's 3m30s does.

## Health

`GET /_gateway/health` never reaches Node. It answers `200 {"status":"ok","mode":"proxy","app":"up"}`. It answers `503` with `"draining"` during a drain and `"app_down"` when Node's port refuses a connection. That probe is cached for 1 s. A client on this machine, by the client-IP rule, also gets `inflight`, `uptimeSeconds`, `version` and `goroutines`.

In `native` mode the body also has `"native": "ready"` or `"native": "off"`, and with `off`, for a client on this machine, a `nativeReason` such as `schema version 7 is newer than this gateway knows (6)` or `the app server runs on sql.js, ...`. Native routes being off never fails the check: everything is proxied then.

## SQLite sharing (phase 2)

Phase 1 doesn't open the database. From phase 2 both processes share `DATA_DIR/db/data.sqlite`. Usage tables live in that same file, because `usageRepo` uses the same adapter.

**Driver.** `modernc.org/sqlite`, pure Go, because the image is Alpine and the gateway is built with `CGO_ENABLED=0`. It is the only planned dependency. It is slower than C SQLite on heavy queries, but the hot path runs a handful of indexed lookups and short writes.

**Pragmas.** These match `src/lib/db/schema.js`: `journal_mode=WAL` (Node sets it, and it persists in the file), `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`. The gateway keeps one writer connection and a small reader pool. It also sets `wal_autocheckpoint=0`, since SQLite would otherwise checkpoint on the committing connection, and opens the file read-write without create (`mode=rw`), so it never makes a database Node hasn't.

**Node's transactions are `BEGIN IMMEDIATE`.** A deferred transaction that reads before it writes (`updateSettings`, `updateProviderConnection` and every other read-merge-write repo) can't wait for another process's write lock. SQLite skips the busy handler when a reader upgrades, so it fails at once with `SQLITE_BUSY`. The better-sqlite3, bun:sqlite and node:sqlite adapters therefore begin their outermost transaction `IMMEDIATE`, and nested calls stay savepoints. With one process this changes nothing. `tests/unit/db-shared-file.test.js` holds the lock from a second process and fails with deferred transactions. The pre-migration backup (`backupDbLite`) is the one exception and keeps a deferred `BEGIN`: it only reads `main` while it copies into an attached file, and an IMMEDIATE one would write-lock `main` for the whole copy.

**Rules for sharing the file:**
- Every write is a short `BEGIN IMMEDIATE` transaction that reads the row fresh and changes only the fields the gateway owns. Node's `better-sqlite3` waits on a lock synchronously, on its main thread, for up to 5 s. A gateway transaction held long therefore freezes the whole Node event loop.
- The gateway leaves Node windows to take the lock. SQLite has no queue for its write lock: a waiter polls, sleeping 1 to 100 ms between tries, and the lock goes to whoever asks while it is free. A gateway that began its next write as soon as the last committed would win every time. The first stress run showed that: Node's writes waited out the full 5 s and failed, with event-loop lag at p99 over 5 s, while every gateway write landed. So all the gateway's writes go through one goroutine (`writer.go`). It puts every write queued at that moment into one transaction, each in its own savepoint so a failure undoes only itself. It stops taking more after holding the lock 10 ms (`MaxWriteHold`), and leaves the lock free at least 25 ms (`WriteGap`) before it begins again. Usage rows are also batched every 100 ms.
- No read transaction stays open. Node runs `wal_checkpoint(TRUNCATE)` every 60 s, and a long-lived reader stops the checkpoint and lets the WAL grow. The gateway's connections never checkpoint (`wal_autocheckpoint=0`). The one exception is the gateway's last close after Node has exited, when SQLite checkpoints on its own.
- If Node runs on `sql.js` (in memory, rewriting the whole file), the file can't be shared. Node records its driver in `_meta.dbDriver` each time it opens the database, after its migrations (`recordDriver` in `driver.js`; sql.js writes it to disk with its next save). The gateway stays in proxy mode unless it is `better-sqlite3`, `bun:sqlite` or `node:sqlite`, and re-checks when that row changes. The schema guard also refuses a file that isn't in WAL mode.

**What the gateway reads and writes:**

| Table | Reads | Writes |
|---|---|---|
| `_meta` | `schemaVersion`, `configGeneration`, `dbDriver` | `totalRequestsLifetime` (increment, in the usage transaction) |
| `settings` | the JSON row | never |
| `apiKeys` | key lookup, policy (budget, allowlist, expiry) | `spentUsd`, `requestCount`, `lastUsedAt` (in the usage transaction) |
| `combos` | by name | never |
| `providerNodes` | `openai-compatible` nodes (prefix, baseUrl, apiType, modelRoutes, droppedBetas, overrides) | `droppedBetas` (merge) |
| `providerConnections` | active connections with `data` | in `data` only: `modelLock_*`, `modelLimit_*`, `modelNoHeaders_*`, `providerReset_*`, `backoffLevel`, `lastError`, `lastErrorAt`, `errorCode`, `testStatus`, the `authFail*` streak fields, `authDemote_*` (compare-and-swap, as Node does) and `authDemoteOkAt`, `lastUsedAt`, `consecutiveUseCount`, `providerSpecificData.droppedBetas` (merge); and auto-disable: the `isActive` column with `autoDisabledAt` and `autoDisabledReason` |
| `proxyPools` | by id | never |
| `kv` | scopes `modelAliases`, `pricing`, `customModels` | never |
| `usageHistory` | never | insert |
| `usageDaily` | the day's row | read-modify-write of the day's JSON aggregate |
| `requestDetails` | never | upsert, only when observability is on |

Everything else is Node's alone: management keys, audit, notification channels, migrations, OAuth tokens and their refresh.

**Schema ownership.** Node's migrations own the schema. The gateway never creates or alters a table. Node opens its database, and on a fresh install creates and migrates it, on its first use of it, which can come after it listens. So the gateway opens the file once Node listens, keeps trying every second until it exists, and the schema guard tells an unmigrated file apart. The gateway is built with a manifest: the highest migration number it knows (`_meta.schemaVersion`, which counts migration files, 6 today) and the columns it uses in each table. `SCHEMA_VERSION` in `schema.js` (stored as `_meta.backupSchemaVersion`) also moves on purely additive table changes, so the column check, not that counter, is what catches those. At startup, and whenever `PRAGMA schema_version`, `_meta.schemaVersion` or `_meta.dbDriver` changes, the gateway checks `_meta.schemaVersion` and `PRAGMA table_info`. A newer version or a missing column switches native routes off. Everything is proxied, the health endpoint says why, and one line is logged. Extra tables and columns are fine, because `syncSchemaFromTables` only adds. A migration that changes a column the gateway reads must bump the manifest in the same PR, and CI runs the gateway's schema check against a database migrated by that PR's Node.

## Config sync (phase 2)

Node caches settings for 5 s with an in-process generation counter. It reads connections, combos, nodes, API keys and aliases from the database on every request. A second process can't see an in-process counter, so:

- Node bumps `_meta.configGeneration` in the same transaction as every write to `settings`, `combos`, `providerNodes`, `apiKeys`, and the `kv` scopes `modelAliases`, `pricing` and `customModels`. It also bumps it on dashboard edits of `providerConnections`, but not on the lock and usage writes the hot path makes. The bump is `bumpConfigGenerationSync` (or `writeConfig`) in `src/lib/db/helpers/configGeneration.js`. A connection write bumps when `connectionConfigChanged` finds a change outside the runtime fields (locks, errors, auth evidence and demotions, rotation, the top-level token fields, auto-ping stamps). A key turned off, which changes the `isActive` column, counts. So does a token refresh that also rewrites `providerSpecificData`; that costs the gateway one reload. The gateway bumps the same way for its own config writes: a node's `droppedBetas`, a connection's `providerSpecificData.droppedBetas`, and an auto-disable.
- `tests/unit/config-generation.test.js` lists every SQL statement in `src/` and `open-sse/` that writes one of those tables, by file and function, with whether it bumps or why it needn't (usage spend, migrations, kv scopes the gateway doesn't read). A new write fails it until it is listed. Each listed site that bumps is then run on sql.js, node:sqlite and better-sqlite3 through an adapter that checks every config write has a bump in its own transaction, and the lock, usage and token-refresh writes are checked to leave the generation alone.
- The gateway polls `PRAGMA data_version` every 250 ms. That pragma changes when another connection commits, and costs no I/O. When it changes, the gateway reads `configGeneration` and reloads its snapshot if that changed too. The usage writes on every request change `data_version` but not the generation, so they cost one indexed read.
- On top of that, a 5 s TTL caps how stale a snapshot can get, the same bound Node's own settings cache has today.
- Per-request state stays per request: locks and demotions are read fresh from `providerConnections` at pick time, as Node reads them.

## Phase 2b: the database layer

Status: built and tested, serving nothing. `gateway/internal/db` is the driver, the pragmas, the schema guard, the watcher and the typed readers and writers for the table above. In `native` mode the gateway opens the database once Node listens, checks it and keeps the snapshot current, and health and the log report the result. Nothing calls the writers yet; phase 2c's native route will. Production runs with `GATEWAY_MODE` off, so none of this runs there.

**Schema guard.** `manifest.json` (embedded) holds the highest migration the gateway knows, the drivers it shares a file with, and the columns it reads in each table. `DB.Check` refuses, with a reason, a file whose `_meta.dbDriver` is sql.js, missing or unknown, one not in WAL mode, a `_meta.schemaVersion` above the manifest's, or a table without a column the manifest lists. Extra tables and columns pass. The watcher re-runs the check whenever `PRAGMA schema_version`, `_meta.schemaVersion` or `_meta.dbDriver` changes, and every 5 s while it refuses. It logs one line per change of answer. `tests/unit/gateway-db-manifest.test.js` holds the manifest to `schema.js` and the migration list, and holds the Go tests' schema (`testdata/schema.sql`) to the statements migrations run. A new migration therefore fails CI until the manifest says the gateway can read it.

**JSON.** Rows the gateway rewrites go through `internal/db/jsjson`, which parses and prints JSON as `JSON.parse` and `JSON.stringify` do. Object keys keep their order, with array-index keys first, as V8 orders them. Numbers are printed as `Number#toString` prints them, and strings are escaped as JavaScript escapes them, a lone surrogate (an error message cut in the middle of an emoji) included. A row the gateway writes is the text Node would have written, unknown fields included.

**Writers.** Each reads its row fresh inside the writer's `BEGIN IMMEDIATE` transaction and changes only what it owns. Callers wait for their own write. A write is reported failed only if it didn't land: when SQLite rolls a whole transaction back (an I/O error, a full disk), every write in it fails and the rest wait for the next. A write whose context ends before it starts is skipped, and when the lock doesn't come within the busy timeout, every write queued then fails at once rather than each waiting 5 s. A usage row that can never be written (a value the JSON writer refuses) is dropped and counted rather than holding the rows behind it. The price of the pacing is latency, not throughput: a write that arrives just after a commit waits out the gap, so one waits up to about 35 ms (25 ms gap, 10 ms hold), and under load many share each transaction. Phase 2c's lock writes should not sit on a request's critical path.

- `UpdateConnection(ctx, id, ConnectionUpdate)` is `updateProviderConnection` for the hot path's options: `Set` (owned fields only; anything else is `ErrNotOwned`), `AutoDisable` (only while another connection of the provider is on), `Demote` (compare-and-swap on the `JSON.stringify` of the record, plus `probeNow`), `LiftDemote`, `NoteServed` and `APIKeyUsed` (a key pasted in since drops the streak, the turn-off and the demotion). It writes `data`, `isActive` and `updatedAt` and returns the merged row.
- `MergeDroppedBetas(ctx, connectionID, nodeID, betas, ownBaseURL)` is `saveDroppedBetas`: the union rule of `sanitizeNodeQuirks`, on the connection's `providerSpecificData` and the node.
- `WriteUsage(ctx, entries)` writes many requests in one transaction: their `usageHistory` rows, each day's `usageDaily` aggregate read and written once, `_meta.totalRequestsLifetime` and each key's spend. The result is what `saveRequestUsage` gives for them one at a time, float rounding included. `NewUsageWriter` batches `Add`ed rows every 100 ms. Local dates use the process's zone, as Node's `Date` does; the binary carries its own zone data.
- `SaveRequestDetails(ctx, rows, maxRecords)` is the request-detail flush: upsert, full copies on the newest 25 rows only, trim to `maxRecords`. It takes payloads already capped.

**Readers.** `ListConnections(ctx, provider, active)` sorts as `getProviderConnections` does, `ConnectionByID`, `APIKeyByKey` (fresh, for spend), `NodeByID`, `ProxyPoolByID`, `APIKeys` and `Nodes`. Each type's `NodeObject()` is the object Node's repo returns for the row.

**The snapshot API for 2c.**

```go
path, err := db.DataFile(os.Getenv)                     // DATA_DIR/db/data.sqlite, as Node resolves it
d, err := db.Open(path, db.Options{})
err = d.Watch(ctx, db.WatchOptions{OnStatus: logIt})   // first check and load, then every 250 ms
st := d.Status()                                        // Ready, Reason, SchemaVersion, Driver
s := d.Snapshot()                                       // nil unless Ready
s.Settings.Bool("requireApiKey")                        // getSettings(), defaults merged, retired keys dropped
s.Combos["name"]; s.Nodes["openai-compatible-chat-…"]   // by name, by id
s.APIKeys["sk-…"]                                       // policy; spend via d.APIKeyByKey
s.Alias("sonnet"); s.Pricing; s.CustomModels
```

A snapshot is immutable; `Watch` swaps in a new one when `configGeneration` moves, and at least every 5 s. Phase 2c should hold one snapshot per request.

**For 2c, on Node's side.** Node's in-process caches keyed on `connectionsVersion()` and `combosVersion()` (auto-combo, the Codex catalog) don't see the gateway's writes. Once the gateway turns keys off, those caches should also watch `_meta.configGeneration`.

## State that lives in Node's memory

Most routing state lives only in Node process memory today: rotation, prompt-cache affinity, the per-provider selection mutex, auth evidence, hung-model state, memory admission and the request-detail buffer. The 429 locks and demotions are in the database and need no change. The design keeps each piece of memory state in one process by routing whole providers. A provider allowlisted for native chat sends all its chat traffic through the gateway, so the gateway alone holds:

- prompt-cache warm keys (`open-sse/services/cacheAffinity.js`),
- the selection mutex and round-robin stickiness (`src/sse/services/auth.js`),
- auth evidence and spread leases for dead-key demotion (`auth.js`, `spreadLeases.js`),
- model-hang state (`open-sse/services/modelHang.js`),
- combo rotation (`open-sse/services/combo.js`),
- its own memory admission gate.

The dashboard reads some live state from Node's memory: pending counters, the recent-requests ring, `lastUsed` indexes and the usage event stream. Node will tail `usageHistory` by rowid every second to fold in rows the gateway wrote. That needs no new IPC, and the rows are the source of truth anyway. "Recent requests" per endpoint and the pending counters for gateway traffic come through a loopback endpoint on Node, `POST /api/internal/gateway/events`. It is authenticated with the peer token and batched every 250 ms. If it's down, the dashboard loses a live view, never a usage row.

## Parity testing

Nothing turns native until it matches Node byte for byte on recorded traffic.

1. **Golden fixtures from the Node path.** A recorder (a test-only executor wrapper, behind an env flag in CI only) captures, for each fixture request:
   - the client request;
   - the exact upstream request Node sent: URL, headers (keys redacted), body bytes;
   - the upstream response;
   - the bytes Node wrote to the client;
   - the database writes, as row diffs.

   Fixtures come from the e2e mock upstream and from synthetic bodies shaped like production: 50 to 1,000 messages, 12 to 48 tools, thinking blocks with signatures, `cache_control` in every position, images, `tool_result` with `is_error`. Every value is synthetic, with no real keys, hosts or prompts.
2. **Transform tests.** The Go request preparation runs on every fixture's client body and must produce the same upstream body bytes as Node. JSON key order and number formatting count, because the upstream's prompt cache keys on bytes. This is where most of phase 2's risk sits.
3. **Byte-level SSE comparison.** Mock upstream response in, client bytes out. Event framing, `[DONE]`, keepalive comments, early headers at 30 s, error events after early headers, and usage extraction must all match. Generated ids and timestamps are normalized first. Phase 1's e2e already does this for `/v1/messages` with the gateway off and in proxy mode.
4. **Shadow compare in CI.** One process mode, `GATEWAY_SHADOW=1`, CI only. Node serves the client. The gateway computes its upstream request for the same input and logs a diff against what Node sent, and it never sends. This runs on the fixture corpus and on the full e2e suites.
5. **Canary in production.** `native` mode with the route allowlisted for one provider node whose keys are few. Compare usage rows, error rates and cache-hit rates against the other nodes for a day, then widen.

## Phase 2: the hot path, natively

The scope is `POST /v1/messages`, `stream: true`, Anthropic Messages format in, through a combo to `openai-compatible-chat-*` nodes whose connection routes the model to the Anthropic Messages API.

The log line reads `FMT: claude→claude`, but this is not a pass-through. That line means Node ran its full Claude request preparation on the body. The lossless path logs `FMT: claude (passthrough)`. It only runs when the client is detected as Claude Code and the provider is `claude`, `anthropic` or `anthropic-compatible-*` (`isNativePassthrough` in `open-sse/utils/clientDetector.js`, gated again on the transport route in `chatCore.js`). So the port has to reproduce the preparation exactly. That is the biggest single piece of work.

### Behaviors to port, with the Node code each Go package replaces

| Go package | Behavior | Node code |
|---|---|---|
| `internal/route` | `/v1/messages` entry and the `/v1/v1` rewrites; body read; 400 on a non-object or missing model; `[1m]` marker strip; the Claude Code bypass for warmup, title and count requests | `next.config.mjs` rewrites, `src/app/api/v1/messages/route.js`, `src/sse/handlers/chat.ts` entry, `src/sse/utils/requestBody.js`, `open-sse/utils/bypassHandler.js` |
| `internal/clientauth` | Key from `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`; the public-LLM check (local, CLI token or valid key; management keys refused); `requireApiKey`; expiry (401), model allowlist with alias and combo expansion (403), budget (402); dropping `speed` and `service_tier` for budgeted keys | `src/shared/utils/clientApiKey.js`, `src/dashboardGuard.js` public branch, `src/sse/services/keyLimits.js`, `src/shared/utils/apiKeyLimits.js`, `src/lib/db/repos/apiKeysRepo.js` |
| `internal/admission` | In-flight body budget (`INFLIGHT_BODY_BUDGET_MB`), FIFO queue with `INFLIGHT_QUEUE_WAIT_MS`, 503 `overloaded_error` with `Retry-After`, RSS high-water from the cgroup. The gateway's own budget, sized for one body copy instead of Node's three. A body without Content-Length counts as `INFLIGHT_UNKNOWN_BODY_MB` until read, not 0 | `src/sse/services/memoryAdmission.js`, `open-sse/config/runtimeConfig.js` |
| `internal/combo` | Combo lookup, member resolution through node prefixes, nesting up to depth 4 with a cycle check, `fallback` strategy (every member error falls through), the 5 s transient wait rule, the combo limit hold | `open-sse/services/combo.js`, `src/sse/services/model.js`, `src/lib/db/repos/combosRepo.js`, `chat.ts` combo branch |
| `internal/accounts` | Connection listing and filtering (locks, quota, plan); `fill-first`, `round-robin` with stickiness, `soonest-reset`; prompt-cache affinity keys, warm-key preference and the wait (`CACHE_AFFINITY_*`); 429 and error locks with exponential backoff from `ERROR_RULES`; lock clearing on stream start; header-timeout and same-request-error stops; dead-key evidence, demotion, probes and auto-disable; model hang | `src/sse/services/auth.js`, `open-sse/services/accountFallback.js`, `open-sse/config/errorConfig.js`, `open-sse/services/cacheAffinity.js`, `open-sse/utils/sessionManager.js`, `open-sse/services/modelHang.js`, `spreadLeases.js`, `src/lib/db/repos/connectionsRepo.js`, `chat.ts` account loop |
| `internal/claudeprep` | The request rewrite: `stripContentTypes`, `normalizeThinkingConfig`, tool-call id repair, `applyThinking` from model capabilities, `prepareClaudeRequest` (max-tokens clamp, empty-block drops, `cache_control` reset and re-placement, message and tool repair, tool-choice relax), upstream model id, `dedupeTools` for Claude Code, `type:"custom"` tools, `temperature` strip, beta body fields, endpoint overrides, `finalizeBody` | `open-sse/translator/index.ts`, `open-sse/translator/formats/claude.js`, `open-sse/translator/concerns/thinkingUnified.js`, `open-sse/translator/concerns/paramSupport.js`, `open-sse/services/provider.js`, `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js` (prep steps), `open-sse/utils/toolDeduper.js`, `open-sse/handlers/chatCore/endpointOverrides.ts`, `src/shared/utils/endpointOverrides.ts`, `open-sse/executors/default.js`, `open-sse/executors/base.js` (`finalizeBody`) |
| `internal/upstream` | Runtime transport (base URL suffix, `x-api-key` plus `Authorization`, `anthropic-version`, `anthropic-beta` merge and filtering, learned `droppedBetas` and the two beta retries); per-status retries; the 240 s headers budget; per-connection proxy pools and env proxies; body bytes reused across keys | `open-sse/executors/base.js`, `open-sse/executors/default.js`, `open-sse/utils/proxyFetch.js`, `open-sse/utils/headersTimeout.js`, `src/lib/network/connectionProxy.js` |
| `internal/stream` | Early SSE headers after `STREAM_EARLY_HEADERS_MS` with keepalives; the error event after early headers; pass-through relay with the short-id fix and the trailing `data: [DONE]`; usage from `message_start` and `message_delta`; stall abort; disconnect handling with the 500 ms grace; abort billing floor | `open-sse/utils/earlyHeaders.js`, `open-sse/utils/stream.js`, `open-sse/utils/streamHandler.js`, `open-sse/utils/usageTracking.js`, `open-sse/handlers/chatCore/streamingHandler.js` |
| `internal/usage` | Cost from user pricing overrides, then the built-in tables; the usage transaction (`usageHistory`, `usageDaily`, `_meta`, `apiKeys` spend); request-detail rows (5 KB or 128 KB previews, gzip full copies, newest 25, batching) | `src/lib/db/repos/usageRepo.js`, `src/lib/db/repos/pricingRepo.js`, `open-sse/providers/pricing.js`, `open-sse/handlers/chatCore/requestDetail.js`, `src/lib/requestDetailsDb.js`, `src/lib/db/repos/requestDetailsRepo.js` |
| `internal/db` (built in 2b, see "Phase 2b") | Driver, pragmas, schema manifest and guard, `data_version` and generation watcher, the batched writer | `src/lib/db/driver.js`, `src/lib/db/schema.js`, `src/lib/db/migrate.js` |

Phase 2 leaves out the `fusion` and `round-robin` combo strategies, other client formats, Codex session affinity, side-search hooks and every other provider. A request that needs any of them goes to Node.

### Risks

- **Byte-exact request preparation.** A one-byte difference in the upstream body can silently halve prompt-cache hits and double cost. The transform tests run over a large corpus and the shadow compare runs before any canary. The Go JSON handling must keep key order and number text from the client, so it edits a raw-preserving representation and never round-trips through `map[string]any`.
- **SQLite lock contention freezing Node.** Covered by the short-transaction, paced-writer and no-open-reader rules above. The `Gateway DB` workflow's stress job hammers both processes and fails if Node's event-loop lag reaches 50 ms at p99 (see "Verifying phase 2b").
- **Split memory state.** If a provider is half native and half proxied, for example during a rollout or when a request falls back to Node, the two processes keep separate affinity and evidence maps. Cache affinity then gets worse for those requests, and dead-key evidence builds more slowly. Locks are unaffected because they live in the database. Rollouts flip a provider whole.
- **Drift as Node changes.** Every PR that touches a file in the map above must update the Go port or mark the route proxy-only. A CI job will fail a PR that changes a mapped file without touching `gateway/` or a `GATEWAY_PROXY_ONLY` list.
- **Two memory budgets under one container limit.** Admission budgets for both processes have to add up under the cgroup's `memory.max`, with Go's counted at its real single-copy weight.
- **Driver performance.** `modernc.org/sqlite` is pure Go. The `Gateway DB` workflow's bench job times the hot-path queries on it against better-sqlite3 and node:sqlite.

## Later phases

- **Phase 3.** The same providers on `/v1/chat/completions` and `/v1/responses`, with the OpenAI pivot translators the hot traffic uses. `round-robin` and `fusion` combos.
- **Phase 4.** Other API-key providers through the default executor. OAuth providers stay in Node, which owns token refresh, until their refresh logic is ported and holds a cross-process lease in the database.
- **Phase 5.** The Codex WebSocket bridge in Go, replacing the loopback POST with an in-process call.
- Node keeps the dashboard, management APIs, OAuth flows, cloud sync and the long tail of providers for the foreseeable future. The gateway's job is the hot path.

## Rolling back

Set `GATEWAY_MODE=off`, or unset it, and redeploy. Node takes port 20128 again with nothing of the gateway running. No data changes: phase 1 never opens the database, and phase 2b's `native` mode only reads it (apart from SQLite's own checkpoint when the gateway closes it after Node has exited). In phase 2 everything the gateway writes uses Node's own tables and formats. The two rows Node adds to `_meta` (`dbDriver`, `configGeneration`) mean nothing to a Node without them.

## Verifying phase 1

The `Go gateway` workflow (`.github/workflows/gateway.yml`) runs:

- `go vet` and `go test -race` on `gateway/`, plus no-cgo builds for amd64 and arm64;
- the client-IP parity table against custom-server.js;
- the whole vitest suite against the base branch, failing only on new failures;
- the proxy-overhead benchmark;
- an e2e on the built image, which runs the same checks with `GATEWAY_MODE` unset and with `proxy`:
  - process layout and the health endpoint;
  - local, remote and spoofed-header clients;
  - an Anthropic Messages stream, with byte-compared bodies between the two legs;
  - per-chunk flush timing and a 4 MB body;
  - Codex WebSocket turns, local and remote;
  - dashboard status codes;
  - a graceful stop in the middle of a stream.

## Verifying phase 2b

`go test -race` in the `Go gateway` workflow covers `internal/db`: the guard's answers, the watcher (a usage write doesn't reload, a generation bump does, the TTL does, a schema change turns native off), every writer's exact output, a write waiting out another connection's lock, the writer's pacing (another connection gets the lock within 500 ms while 16 goroutines write), and the pragmas. The `Gateway DB` workflow (`.github/workflows/gateway-db.yml`) runs the rest against this branch's Node:

- `node`: the config generation guard on sql.js, node:sqlite and better-sqlite3 (bun:sqlite isn't in CI), the manifest and test schema guard, and IMMEDIATE transactions across two processes. The guard also runs alone, in the `Config generation` workflow, on any change under `src/` or `open-sse/`.
- `parity` (TZ `Pacific/Chatham`): the guard on databases better-sqlite3 and node:sqlite migrated (and its refusals of sql.js, a newer schema, a dropped column); the Go readers against Node's repos; and the same writes through Node on one file and the gateway on its copy, compared row by row and read back through Node's repos.
- `stress`: Node on better-sqlite3, then on node:sqlite, runs its request loop alone for 10 s and then for 30 s beside `gateway-dbtool stress`, with a TRUNCATE checkpoint every 5 s. The gateway writes 500 usage rows/s in 100 ms batches, 100 connection writes/s and 50 request-detail rows/s, with 4 readers. The job fails on a Node event-loop lag p99 of 50 ms or more, on any SQLITE_BUSY or other error on either side, or on a lost row. The tables are in the job summary.
- `bench`: connection listing, key lookup and usage writes on better-sqlite3, node:sqlite and modernc.org/sqlite, in the job summary.
