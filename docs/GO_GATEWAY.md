# Go gateway

A Go process in front of the Node app server. It takes over the hot inference path one route at a time and relays everything else to Node. Phase 1, this document's first deliverable, ships proxy mode only: the gateway relays every request and serves nothing itself. `GATEWAY_MODE=off` is the default, and with it the container runs exactly as before.

Why Go: all of Node's request handling (body parsing, rewriting, SSE relay) runs on one JS thread. On a busy install that one thread is what saturates first, however many cores the box has. The hot path parses 1 to 4 MB JSON bodies, rewrites them and relays SSE. Go can spread that over every core and allocate far less per request.

The code is in `gateway/`, a Go module with no dependencies outside the standard library in phase 1.

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
| `GATEWAY_MODE` | `off` | `off`: Node alone on `PORT`. `proxy`: the gateway relays everything. `native`: proxy plus the routes the gateway serves itself. This build has none, so it acts like `proxy` and logs that. |
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

## SQLite sharing (phase 2)

Phase 1 doesn't open the database. From phase 2 both processes share `DATA_DIR/db/data.sqlite`. Usage tables live in that same file, because `usageRepo` uses the same adapter.

**Driver.** `modernc.org/sqlite`, pure Go, because the image is Alpine and the gateway is built with `CGO_ENABLED=0`. It is the only planned dependency. It is slower than C SQLite on heavy queries, but the hot path runs a handful of indexed lookups and short writes.

**Pragmas.** These match `src/lib/db/schema.js`: `journal_mode=WAL` (Node sets it, and it persists in the file), `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`. The gateway keeps one writer connection and a small reader pool.

**Rules for sharing the file:**
- Every write is a short `BEGIN IMMEDIATE` transaction that reads the row fresh and changes only the fields the gateway owns. Node's `better-sqlite3` waits on a lock synchronously, on its main thread, for up to 5 s. A gateway transaction held long therefore freezes the whole Node event loop.
- The gateway batches usage writes, many rows per transaction every 100 ms or so, to take the write lock less often.
- No read transaction stays open. Node runs `wal_checkpoint(TRUNCATE)` every 60 s, and a long-lived reader stops the checkpoint and lets the WAL grow. Only Node checkpoints.
- If Node runs on `sql.js` (in memory, rewriting the whole file), the file can't be shared. Node will record its driver in `_meta.dbDriver`, and the gateway stays in proxy mode unless it is `better-sqlite3`, `bun:sqlite` or `node:sqlite`.

**What the gateway reads and writes:**

| Table | Reads | Writes |
|---|---|---|
| `_meta` | `schemaVersion`, `configGeneration`, `dbDriver` | `totalRequestsLifetime` (increment, in the usage transaction) |
| `settings` | the JSON row | never |
| `apiKeys` | key lookup, policy (budget, allowlist, expiry) | `spentUsd`, `requestCount`, `lastUsedAt` (in the usage transaction) |
| `combos` | by name | never |
| `providerNodes` | `openai-compatible` nodes (prefix, baseUrl, apiType, modelRoutes, droppedBetas, overrides) | `droppedBetas` (merge) |
| `providerConnections` | active connections with `data` | in `data` only: `modelLock_*`, `modelLimit_*`, `modelNoHeaders_*`, `providerReset_*`, `backoffLevel`, `lastError*`, `errorCode`, `testStatus`, `authDemote_*` (compare-and-swap, as Node does), `lastUsedAt`, `consecutiveUseCount`, `droppedBetas`, `isActive` (auto-disable) |
| `proxyPools` | by id | never |
| `kv` | scopes `modelAliases`, `pricing`, `customModels` | never |
| `usageHistory` | never | insert |
| `usageDaily` | the day's row | read-modify-write of the day's JSON aggregate |
| `requestDetails` | never | upsert, only when observability is on |

Everything else is Node's alone: management keys, audit, notification channels, migrations, OAuth tokens and their refresh.

**Schema ownership.** Node's migrations own the schema. The gateway never creates or alters a table. Node migrates before it listens, and the gateway reads the database only after Node listens. The gateway is built with a manifest: the highest migration number it knows (`_meta.schemaVersion`, which counts migration files, 6 today) and the columns it uses in each table. `SCHEMA_VERSION` in `schema.js` (stored as `_meta.backupSchemaVersion`) also moves on purely additive table changes, so the column check, not that counter, is what catches those. At startup and whenever the schema could have changed, the gateway checks `_meta.schemaVersion` and `PRAGMA table_info`. A newer version or a missing column switches native routes off. Everything is proxied, the health endpoint says why, and one line is logged. Extra tables and columns are fine, because `syncSchemaFromTables` only adds. A migration that changes a column the gateway reads must bump the manifest in the same PR, and CI runs the gateway's schema check against a database migrated by that PR's Node.

## Config sync (phase 2)

Node caches settings for 5 s with an in-process generation counter. It reads connections, combos, nodes, API keys and aliases from the database on every request. A second process can't see an in-process counter, so:

- Node bumps `_meta.configGeneration` in the same transaction as every write to `settings`, `combos`, `providerNodes`, `apiKeys`, `kv` aliases and pricing. It also bumps it on dashboard edits of `providerConnections`, but not on the lock and usage writes the hot path makes.
- The gateway polls `PRAGMA data_version` every 250 ms. That pragma changes when another connection commits, and costs no I/O. When it changes, the gateway reads `configGeneration` and reloads its snapshot if that changed too. The usage writes on every request change `data_version` but not the generation, so they cost one indexed read.
- On top of that, a 5 s TTL caps how stale a snapshot can get, the same bound Node's own settings cache has today.
- Per-request state stays per request: locks and demotions are read fresh from `providerConnections` at pick time, as Node reads them.

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

1. **Golden fixtures from the Node path.** A recorder captures, for each fixture request:
   - the client request;
   - the exact upstream request Node sent: URL, headers (keys redacted), body bytes;
   - the upstream response;
   - the bytes Node wrote to the client;
   - the database writes, as row diffs.

   Fixtures come from synthetic bodies shaped like production: 50 to 1,000 messages, 12 to 48 tools, thinking blocks with signatures, `cache_control` in every position, images, `tool_result` with `is_error`. Later phases add the e2e mock upstream. Every value is synthetic, with no real keys, hosts or prompts.

   In place for `internal/claudeprep` (phase 2a), the request half:
   - **Corpus.** `tests/helpers/claudeprepCorpus.js` generates the cases. Its JSON writer can emit what `JSON.stringify` never does: `1.0`, `1e3`, big integers, duplicate and integer-like keys, escapes, CRLF and tab whitespace, and invalid UTF-8 bytes. The large corpus also runs every capability family against every thinking intent and every `(level)` suffix.
   - **Recorder.** `tests/unit/gateway-claudeprep-parity.test.js` is part of the default vitest suite. It runs each case through chat.ts's body steps (restated there, since `internal/route` owns them) and the real `handleChatCore`. A `vi.mock` of `proxyAwareFetch`, under the executor, captures the URL, the headers object and the body bytes, with keys redacted as `{{apiKey}}`. Nothing leaves the process.
   - **Fixtures.** The repo keeps 178 fixtures in `gateway/internal/claudeprep/testdata/fixtures`, with the prose cut short. The core cases keep histories of 50 to 120 messages and 12 to 48 tools. The test fails if Node no longer makes them, or no longer matches the table export, so a Node change that would break parity fails in Node's own suite as well.
   - **Recording.** `CLAUDEPREP_RECORD=1` rewrites the fixtures and `tables.json`. With `CLAUDEPREP_LARGE=1` and `CLAUDEPREP_OUT` it writes the large corpus instead: about 1,100 cases, including histories of 1,000 to 1,400 messages.
2. **Transform tests.** The Go request preparation runs on every fixture's client body and must produce the same upstream body bytes as Node. JSON key order and number formatting count, because the upstream's prompt cache keys on bytes. This is where most of phase 2's risk sits.

   For `internal/claudeprep`:
   - `TestParityWithNode` requires the exact URL, header list and body bytes for every fixture Node prepared.
   - It requires a decline, with the reason the generator names, for each case marked `expectDecline`, and a decline for each case Node threw on or refused. Any other decline fails.
   - The `Gateway claudeprep parity` workflow records the large corpus with the PR's own Node, then runs the Go tests on both sets. It requires every generated fixture to load.
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
| `internal/claudeprep` (done, 2a) | The whole upstream request, URL, headers and body. Body: the limit-hold notice, `normalizeThinkingConfig`, tool-call id repair and missing-result stubs, `applyThinking` from model capabilities, the Claude Code prompt for OAuth tokens, `prepareClaudeRequest` (max-tokens clamp, empty-block drops, `cache_control` reset and re-placement, message and tool repair, tool-choice relax), upstream model id, `dedupeTools` for Claude Code, `type:"custom"` tools, `temperature` strip, beta body fields, the reasoning placeholder, endpoint overrides, `finalizeBody`. Headers: auth, `anthropic-version`, the client's `anthropic-beta` merged and filtered (learned `droppedBetas`, first-party flags), identity presets and header lines. It also restates the `[1m]` strip and the budgeted-key drops, which `internal/route` and `internal/clientauth` will call | every file in `gateway/node-map.json` (`claudeprep`), which the drift check reads |
| `internal/upstream` | Sending what claudeprep built: the two beta retries (re-running `Prepare` with the learned flags); per-status retries; the 240 s headers budget; per-connection proxy pools and env proxies, `strictProxy` and `direct`; body bytes reused across keys | `open-sse/executors/base.js`, `open-sse/executors/default.js`, `open-sse/utils/proxyFetch.js`, `open-sse/utils/headersTimeout.js`, `src/lib/network/connectionProxy.js` |
| `internal/stream` | Early SSE headers after `STREAM_EARLY_HEADERS_MS` with keepalives; the error event after early headers; pass-through relay with the short-id fix and the trailing `data: [DONE]`; usage from `message_start` and `message_delta`; stall abort; disconnect handling with the 500 ms grace; abort billing floor | `open-sse/utils/earlyHeaders.js`, `open-sse/utils/stream.js`, `open-sse/utils/streamHandler.js`, `open-sse/utils/usageTracking.js`, `open-sse/handlers/chatCore/streamingHandler.js` |
| `internal/usage` | Cost from user pricing overrides, then the built-in tables; the usage transaction (`usageHistory`, `usageDaily`, `_meta`, `apiKeys` spend); request-detail rows (5 KB or 128 KB previews, gzip full copies, newest 25, batching) | `src/lib/db/repos/usageRepo.js`, `src/lib/db/repos/pricingRepo.js`, `open-sse/providers/pricing.js`, `open-sse/handlers/chatCore/requestDetail.js`, `src/lib/requestDetailsDb.js`, `src/lib/db/repos/requestDetailsRepo.js` |
| `internal/db` | Driver, pragmas, schema manifest and guard, `data_version` and generation watcher, the batched writer | `src/lib/db/driver.js`, `src/lib/db/schema.js`, `src/lib/db/migrate.js` |

Phase 2 leaves out the `fusion` and `round-robin` combo strategies, other client formats, Codex session affinity, side-search hooks and every other provider. A request that needs any of them goes to Node.

### Phase 2a: `internal/claudeprep` (done)

The request rewrite is ported and held byte-identical to Node. Nothing calls it yet, so production is unchanged.

`claudeprep.Prepare(body []byte, in Inputs) (*Request, error)` takes the client's body bytes and returns the upstream request Node would send: the URL, the headers object in Node's key order and spelling, the body bytes, and whether the upstream is asked for SSE. It runs the same steps in the same order as Node:

1. chat.ts: the `[1m]` marker, `speed`/`service_tier` for a budgeted key, `model` set to `<node>/<model>`.
2. chatCore: the limit-hold notice, the model's Messages route (`modelRoutes`), the provider-level thinking override, the upstream `stream` flag, client detection, and unsupported media replaced with placeholders.
3. translateRequest, Claude to Claude: `normalizeThinkingConfig`, tool-call id repair, stubs for missing tool results, `applyThinking` from the model's capabilities, the Claude Code prompt for OAuth tokens, then `prepareClaudeRequest` (max-tokens clamp, blank system and message drops, `cache_control` reset and re-placement, tool ordering and same-role merges, the prefill repair, tool filtering, folding and schema typing, the tool-choice relax).
4. chatCore again: translator-only fields, the upstream model id, `dedupeTools` for Claude Code, `type: "custom"`.
5. DefaultExecutor and the endpoint overrides: headers (auth, the client's `anthropic-beta`, learned and first-party flag drops, identity presets, header lines), the URL query override, the `temperature` strip, beta-gated body fields, the reasoning placeholder some models need, the body overrides, then `finalizeBody`.

The body is edited as a `Value` tree with JavaScript's semantics, never `map[string]any`. Objects keep JavaScript's key order: array-index keys first, ascending, then insertion order, and a repeated key keeps its first slot. Strings are UTF-16 code units held as WTF-8, so a lone surrogate survives. Numbers are float64 and are written back the way `Number#toString` writes them. `JSON.stringify` doesn't keep a client's spelling, and the port matches Node's bytes, not the client's: `1.0` goes out as `1`, `1e3` as `1000`, an escaped `é` as the character itself, and a big integer loses the same digits it loses in Node. A client that already sends `JSON.stringify` output, which Claude Code does, gets its own bytes back. The body is decoded the way `request.text()` decodes it: a BOM is dropped and each ill-formed UTF-8 sequence becomes one U+FFFD.

The capability tables (capabilities.js, thinkingLevels.js, the vision name patterns, the identity presets, the beta-flag field tables) and the constants Node exports (the default max tokens, the level budgets, the API version and host, the Claude Code prompt, the continuation texts, the limit-hold sentinel, the GA thinking displays, the web search tool type) aren't restated in Go. `gateway/internal/claudeprep/tables.json` is exported from Node and embedded, and the Node parity test fails when the export is stale.

Whatever the port doesn't model it hands back with a `*DeclineError` (`claudeprep.IsDecline`), and the gateway proxies that request. That covers:

- any input on which Node would throw, such as a null content block or a non-string `text`, and a connection Node refuses (`blockedReason`);
- a level or effort that names an `Object.prototype` member (`constructor`), which Node's table lookups would find;
- JSON nested more than 512 deep (Node's own recursion fails a few thousand down);
- header values that aren't printable ASCII without edge spaces: fetch sends Latin-1, throws on CR, LF and NUL, and trims, while net/http refuses other control characters;
- the web search tool, which needs Node's built-in search hooks;
- mid-conversation `tool_addition`/`tool_removal` blocks, the client's or a body override's;
- a top-level `allOf`/`anyOf`/`oneOf` or `$ref` in a tool's `input_schema`, which Node flattens;
- a `json_schema` `response_format`;
- non-ASCII model ids and client-identity headers;
- base URLs that aren't plain `http(s)://host[:port]/path?query`: no scheme, a port fetch blocks, dot segments, backslashes, bad escapes, characters the URL parser would percent-encode, IPv6 or underscore hosts. `Request.URL` is the string Node hands fetch; 2c's sender normalizes host case and a default port, as fetch does;
- providers other than `openai-compatible-*`, and models not routed to the Messages API.

### Interfaces for 2b and 2c

`claudeprep.Inputs` is what phase 2b loads:

| Field | Source |
|---|---|
| `Provider`, `Model` | the combo member as `internal/combo` resolved it (`modelInfo`), with its `(level)` suffix |
| `ClientHeaders` | the request's headers, lowercase names |
| `KeyHasBudget` | `apiKeys` policy (`internal/clientauth`) |
| `ProviderThinking` | `settings.providerThinking[provider].mode` |
| `Connection.APIKey`, `.AccessToken` | the picked `providerConnections` row |
| `Connection.Node` | that row's `providerSpecificData`, decoded with `claudeprep.ParseNodeSettings`. It matches keys exactly and refuses types Node's sanitizer never writes (a null `droppedBetas` makes Node throw) |
| `Connection.Blocked` | the connection's resolved proxy rule refuses it (Node's `blockedReason`, which `getProviderCredentials` works out when it picks the account; never the stored row) |
| `Models` | `claudeprep.NewModels(catalog)`. `catalog` implements `claudeprep.Catalog` (`Modalities(model)`, `Limits(provider, model)`) over the models.dev catalog Node syncs. `nil` means none, as in a Node with no catalog installed |

What the callers must do around `Prepare`, because Node does it before chatCore's preparation or outside it:

- `internal/route` runs the bypass check (`handleBypassRequest`, warmup, title and count requests, and `ccFilterNaming`) first, including its throw cases. `Prepare` assumes the request isn't bypassed.
- 2b declines a `providerThinking` mode that isn't a string. Node passes the settings value through unchecked (`{mode: true}` sends `"reasoning_effort": true`), and `ProviderThinking` is a string.
- 2b gives `Prepare` the body as the member sees it. A combo member the capacity adapter added gets the trimmed history (`withCapacityAdapterStripping`), not the client's.
- `ClientHeaders` joins a repeated header with `", "`, as Node's `Headers` does.
- The `Catalog` that 2b implements looks models up the way Node's synced catalog does (its `baseId`: vendor prefix and `:suffix` dropped, lowercased; limits by `model`, then by `baseId`). The fixtures' catalog uses exact keys, so that lookup is 2b's to test.

Phase 2c's `internal/upstream` sends `Request` as given. `Request.Header` is the executor's headers object, not the wire: Node's fetch adds `accept: */*` when no Accept is set, plus `user-agent`, `accept-encoding`, `accept-language` and `sec-fetch-mode`, and 2c has to send the same. For the beta retries it calls `Prepare` again with the learned flags in `Connection.Node.DroppedBetas`, or with `StripBeta`, the way DefaultExecutor re-runs `execute`. `Overrides.Timeout`, `.Retries` and `.Proxy`, and the connection's `strictProxy` and `direct`, are also left to it. A `DeclineError` from any call means Node serves the request, as long as no byte has gone to the client yet.

### Risks

- **Byte-exact request preparation.** A one-byte difference in the upstream body can silently halve prompt-cache hits and double cost. The transform tests run over a large corpus and the shadow compare runs before any canary. The Go JSON handling must produce `JSON.stringify`'s bytes: JavaScript's key order, number text and string escapes. So it edits a tree with JavaScript's semantics and never round-trips through `map[string]any`. Phase 2a does this; see above.
- **SQLite lock contention freezing Node.** Covered by the short-transaction, batched-writer and no-open-reader rules above. A CI stress job will hammer both processes and assert Node's event-loop lag stays under 50 ms.
- **Split memory state.** If a provider is half native and half proxied, for example during a rollout or when a request falls back to Node, the two processes keep separate affinity and evidence maps. Cache affinity then gets worse for those requests, and dead-key evidence builds more slowly. Locks are unaffected because they live in the database. Rollouts flip a provider whole.
- **Drift as Node changes.** Every PR that touches a file in the map above must update the Go port or mark the route proxy-only. `gateway/node-map.json` lists the Node files each package ports, `claudeprep`'s in full (more than the table's row: every helper the port mirrors). The `Gateway drift` workflow (`scripts/gateway-drift-check.mjs`) runs on every PR and fails one that changes a listed file unless the PR changes that package too (`gateway/internal/<pkg>/`, re-recorded fixtures included) or `gateway/GATEWAY_PROXY_ONLY` lists the package. It also fails when a listed file no longer exists, when a mapped package has no `gateway-<pkg>.yml` parity workflow, or when that workflow's path filter misses a listed file. `GATEWAY_PROXY_ONLY` is checked only by CI today; once native routes exist (phase 2c), the gateway embeds it and keeps a listed package's route proxied. The parity fixtures catch what that misses: a behavior change in a file the map doesn't list breaks `tests/unit/gateway-claudeprep-parity.test.js`, which runs in every vitest run.
- **Two memory budgets under one container limit.** Admission budgets for both processes have to add up under the cgroup's `memory.max`, with Go's counted at its real single-copy weight.
- **Driver performance.** `modernc.org/sqlite` is pure Go. The hot-path queries need benchmarking against `better-sqlite3` in CI before the canary.

## Later phases

- **Phase 3.** The same providers on `/v1/chat/completions` and `/v1/responses`, with the OpenAI pivot translators the hot traffic uses. `round-robin` and `fusion` combos.
- **Phase 4.** Other API-key providers through the default executor. OAuth providers stay in Node, which owns token refresh, until their refresh logic is ported and holds a cross-process lease in the database.
- **Phase 5.** The Codex WebSocket bridge in Go, replacing the loopback POST with an in-process call.
- Node keeps the dashboard, management APIs, OAuth flows, cloud sync and the long tail of providers for the foreseeable future. The gateway's job is the hot path.

## Rolling back

Set `GATEWAY_MODE=off`, or unset it, and redeploy. Node takes port 20128 again with nothing of the gateway running. No data changes: phase 1 never opens the database. In phase 2 everything the gateway writes uses Node's own tables and formats.

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
