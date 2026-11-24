# Go gateway

A Go process in front of the Node app server. It takes over the hot inference path one route at a time and relays everything else to Node. Phase 1, this document's first deliverable, ships proxy mode only: the gateway relays every request and serves nothing itself. `GATEWAY_MODE=off` is the default, and with it the container runs exactly as before.

Why Go: at about 200 requests a minute on a 3-core box, Node's main JS thread already uses about 30% of one core, and all of that work is on one thread. More traffic is coming. The hot path parses 1 to 4 MB JSON bodies, rewrites them and relays SSE. Go can spread that over every core and allocate far less per request.

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
- The gateway listens on `HOSTNAME:PORT` (default `0.0.0.0:20128`, what Node used). It starts the command with `PORT=$GATEWAY_APP_PORT` (default 20129), `HOSTNAME=127.0.0.1`, `KEEP_ALIVE_TIMEOUT=30000` and a fresh random `GATEWAY_PEER_TOKEN`. The rest of the environment passes through unchanged.
- The gateway binds its port only after Node accepts connections, so a client during boot gets a refused connection, as it does today, instead of a 502.
- Node's stdout and stderr are the gateway's, so the container log is unchanged. Gateway lines start with `[Gateway]`.
- If Node exits on its own (a crash, an OOM restart, the updater), the gateway exits with the same code, so the restart policy sees what it sees today. A killed Node reports 128 plus the signal, the way a shell does.
- On Linux, Node gets `SIGKILL` if the gateway dies without stopping it (parent-death signal), so a crashed gateway can't leave a Node process holding the database.
- The data dir is still `.9router` and the compose volume is still `9router-data`.
- The gateway reaps only its own child. That matches today, where Node as PID 1 doesn't reap orphans either.
- Memory: the gateway is about 10 to 20 MB RSS when idle. The container's 2 GiB cap now covers both processes.

`GATEWAY_MODE=off` leaves nothing of the gateway running. The entrypoint never starts it. If someone runs the binary with `off` anyway, it `exec`s the command in its own place.

## Modes and settings

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_MODE` | `off` | `off`: Node alone on `PORT`. `proxy`: the gateway relays everything. `native`: proxy plus the routes the gateway serves itself. This build has none, so it acts like `proxy` and logs that. |
| `GATEWAY_APP_PORT` | `20129` | Node's loopback port. If it equals `PORT`, `PORT+1` is used. |
| `GATEWAY_REQUEST_TIMEOUT_MS` | `300000` | Time a client has to send its whole request body. Node's `server.requestTimeout` default. `0` turns it off. |
| `GATEWAY_HEADERS_TIMEOUT_MS` | `60000` | Time a client has to send its headers. Node's `server.headersTimeout` default. |
| `KEEP_ALIVE_TIMEOUT` | `5000` | The public idle keep-alive timeout, read the way Next's standalone `server.js` reads it. |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `180000` | Parsed exactly like `server-drain.js` does. Both processes read it. |
| `TRUST_PROXY` | unset | Read by the client-IP rule, the same value Node reads. |
| `GATEWAY_PEER_TOKEN` | random | Set it only to run the gateway unsupervised in front of a Node you started yourself. |

Phase 2 adds `GATEWAY_NATIVE_ROUTES` (for example `POST /v1/messages`) and `GATEWAY_NATIVE_PROVIDERS` (provider node ids or prefixes such as `openai-compatible-chat-*`). Both are allowlists: a request is native only if its route and every provider it could reach are listed. Everything else is proxied.

The fallback rule: when in doubt, proxy to Node. In phase 2 the gateway proxies whenever:

- the mode is `proxy`, or the route or provider isn't allowlisted;
- the database schema is newer than the gateway understands (see below), or Node runs on `sql.js`;
- the gateway hits anything it doesn't model yet: a setting it can't read, a combo strategy it doesn't port, an endpoint override it can't apply, a client format it doesn't parse.

It may hand a request to Node until the first response byte has gone to the client. It keeps the request body bytes, so the handoff replays them unchanged. After the first byte there is no handoff, and the gateway owns the error, exactly as Node does today.

## Proxy mode in detail

`gateway/internal/proxy` wraps `httputil.ReverseProxy`.

- **No buffering.** Request bodies stream to Node as they arrive, and `FlushInterval: -1` flushes every chunk Node writes. One SSE event goes out as one flush. A test holds back the second megabyte of a 4 MB body until the upstream reports it has the first, so a proxy that buffered would deadlock there.
- **Headers pass through.** That covers `Authorization`, `x-api-key`, `anthropic-beta` and everything else. `Host` is the client's, because Node's origin checks, tunnel detection and local-client rule read it. `ReverseProxy` drops `Forwarded`, `X-Forwarded-For`, `-Host` and `-Proto` before `Rewrite`. The gateway puts the client's values back and adds none of its own, since Node's rule decides whose forwarding headers count.
- **Hop-by-hop headers stop at the gateway in both directions.** These are `Connection` and the headers it lists, `Keep-Alive`, `Proxy-Connection`, `TE` (except `trailers`), `Transfer-Encoding` and `Upgrade`. `Expect: 100-continue` is answered by the gateway and not sent on.
- **No transparent gzip.** The loopback transport has `DisableCompression`, so the client's own `Accept-Encoding` reaches Node untouched. Node compresses or doesn't, as before. The transport also ignores `HTTP_PROXY`, which 10router users set for upstream calls.
- **Timeouts are never shorter than Node's.** The gateway sets no write timeout and no response-header timeout, so streams can run 10 minutes and more. Node sends early SSE headers after 30 s and owns the 240 s upstream headers limit. The request-body bound runs as a read deadline that lifts as soon as the body has been read, so it never cuts a response. A body that misses it gets Node's bare `408` and the upstream request is cancelled.
- **Loopback pool.** Up to 512 idle connections to Node, idle timeout 20 s. Node's keep-alive on that hop is 30 s, so the gateway always closes an idle connection first and never sends a POST on a socket Node is closing at that moment. Such a POST could not be retried.
- **Client aborts.** A client that disconnects cancels the request context, the transport closes the connection to Node, and Node sees `close` and stops the upstream call. A test checks this end to end.
- **WebSocket.** `ReverseProxy` relays `Upgrade: websocket` and splices the two connections after Node's `101`. The Codex bridge runs in Node unchanged.
- **h2c.** custom-server.js serves an `Upgrade: h2c` request (JBR sends them) as the HTTP/1.1 request it also is, and closes the connection afterwards. The gateway does the same before relaying, so Node never sees the upgrade.
- **Node unreachable.** The gateway answers `502` with `{"error":{"code":"gateway_upstream_unavailable",...}}` and `Retry-After: 1`. If Node fails mid-stream, the gateway aborts the client connection, as a destroyed Node socket would.
- **Absolute-form request targets** (`POST http://host/v1/...`). The authority becomes `Host`, as RFC 9112 says it must. Node used the `Host` header instead, but no real client sends absolute-form to an origin server.

Header name casing on responses changes, because Go canonicalizes names. HTTP/1.1 header names are case-insensitive, and the e2e compares bodies, not header spelling.

## Client IP

custom-server.js decides who a request comes from. Forwarding headers count only from a loopback peer or a peer `TRUST_PROXY` lists, and every other peer is its socket address. Rate limits, the login limiter, keyless local `/v1` and audit logs all depend on that.

Behind the gateway, Node's TCP peer is always the gateway on loopback. Without help, every request would look local. So the gateway hands the real peer over:

- On every request it deletes any client copy of `x-9r-gw-token`, `x-9r-gw-peer-ip` and `x-9r-gw-peer-port`. It then sets them to its token and the address and port of the connection it accepted. An IPv4 client of an IPv6 listener is written `::ffff:a.b.c.d`, the spelling Node's socket would report.
- custom-server.js removes the three headers from every request. When `GATEWAY_PEER_TOKEN` is set, the socket is loopback, the token matches (constant-time compare) and the IP parses, it uses the handed peer in place of `req.socket.remoteAddress` for everything: `isOnThisMachine`, `clientKeysFor`, `isTunnelTraffic`, the `x-9r-socket-ip` and `-port` stamps, and the Codex WebSocket bridge's peer. Otherwise it uses the socket, as before. The token leaves `process.env` at boot so Node's children don't inherit it. With `GATEWAY_MODE=off` the variable is unset and none of this code runs.
- A request that reaches Node's loopback port directly, from inside the container, carries no token and is treated as it is today: a loopback client.

The rule itself runs unchanged in Node. `gateway/internal/clientip` is a Go port of it (`isLoopbackHost`, `isOnThisMachine`, `clientKeysFor`, `isTrustedProxyPeer`, `isTunnelTraffic`), down to JavaScript quirks such as `Number("")` being 0 in a `TRUST_PROXY` prefix. In phase 1 it only decides who sees the health endpoint's counters. Phase 2's native routes use it. Both implementations are held to one table, `gateway/internal/clientip/testdata/parity.json`. `go test` reads it, and so does `tests/unit/gateway-clientip-parity.test.js` against custom-server.js. A rule change in one place fails the other until the table and both ports agree.

## Graceful drain and shutdown

The gateway follows `server-drain.js`, and Node runs its own drain alongside.

1. On the first `SIGTERM` or `SIGINT`, the gateway logs `[Gateway] SIGTERM: draining N in-flight request(s)...`, marks itself draining and forwards the signal to Node.
2. `http.Server.Shutdown` closes the listener, so new connections are refused. It also closes each keep-alive connection as it goes idle.
3. A request that still arrives on an open connection gets the same `503` JSON body (`server_draining`), `Retry-After: 5` and `Connection: close`. An upgrade gets the bare `503`.
4. The never-ending dashboard streams (`/api/usage/stream`, the console-log stream, MCP SSE) close at once.
5. Model traffic holds the drain. The gateway counts it with the same path rule as `MODEL_TRAFFIC`, including dot segments, percent-decoding and absolute-form targets. The Go tests use the same cases as `tests/unit/server-drain.test.js`. WebSocket connections don't hold the gateway's drain. A Codex turn holds Node's drain, and the gateway waits for Node.
6. The gateway exits when its own model requests are done and Node has exited, after a 200 ms flush. It exits with Node's exit code.
7. A repeat signal within 1.5 s is the same stop arriving twice: a process-group kill reaches both processes. The gateway ignores it, and so does Node. A later repeat forwards the signal, gives Node 2 s and exits 1.
8. The gateway's deadline is the drain timeout plus 3 s. Node's own timeout fires first, then its listeners get their 2 s. After that the gateway kills Node and exits 1.
9. `SHUTDOWN_DRAIN_TIMEOUT_MS=0` stops both at once, as before.

Docker's `stop_grace_period` must still exceed the drain timeout. The compose file's 3m30s does.

## Health

`GET /_gateway/health` never reaches Node. It answers `200 {"status":"ok","mode":"proxy","app":"up"}`. It answers `503` with `"draining"` during a drain and `"app_down"` when Node's port refuses a connection. That probe is cached for 1 s. A client on this machine, by the client-IP rule, also gets `inflight`, `uptimeSeconds`, `version` and `goroutines`.

## SQLite sharing (phase 2)

Phase 1 doesn't open the database. From phase 2 both processes share `DATA_DIR/db/data.sqlite`. Usage tables live in that same file: `usageRepo` uses the same adapter, despite what older docs say.

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

**Schema ownership.** Node's migrations own the schema. The gateway never creates or alters a table. Node migrates before it listens, and the gateway reads the database only after Node listens. The gateway is built with a manifest: the highest `_meta.schemaVersion` it knows and the columns it uses in each table. At startup and whenever the schema could have changed, it checks `_meta.schemaVersion` and `PRAGMA table_info`. A newer version or a missing column switches native routes off. Everything is proxied, the health endpoint says why, and one line is logged. Extra tables and columns are fine, because `syncSchemaFromTables` only adds. A migration that changes a column the gateway reads must bump the manifest in the same PR, and CI runs the gateway's schema check against a database migrated by that PR's Node.

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

The log line reads `FMT: claude→claude`, but this is not a pass-through. That line means Node ran its full Claude request preparation on the body. The lossless path logs `FMT: claude (passthrough)` and only runs for `claude`, `anthropic` and `anthropic-compatible-*` providers. So the port has to reproduce the preparation exactly. That is the biggest single piece of work.

### Behaviors to port, with the Node code each Go package replaces

| Go package | Behavior | Node code |
|---|---|---|
| `internal/route` | `/v1/messages` entry and the `/v1/v1` rewrites; body read; 400 on a non-object or missing model; `[1m]` marker strip; the Claude Code bypass for warmup, title and count requests | `next.config.mjs` rewrites, `src/app/api/v1/messages/route.js`, `src/sse/handlers/chat.ts` entry, `src/sse/utils/requestBody.js`, `open-sse/utils/bypassHandler.js` |
| `internal/clientauth` | Key from `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`; the public-LLM check (local, CLI token or valid key; management keys refused); `requireApiKey`; expiry (401), model allowlist with alias and combo expansion (403), budget (402); dropping `speed` and `service_tier` for budgeted keys | `src/shared/utils/clientApiKey.js`, `src/dashboardGuard.js` public branch, `src/sse/services/keyLimits.js`, `src/shared/utils/apiKeyLimits.js`, `src/lib/db/repos/apiKeysRepo.js` |
| `internal/admission` | In-flight body budget (`INFLIGHT_BODY_BUDGET_MB`), FIFO queue with `INFLIGHT_QUEUE_WAIT_MS`, 503 `overloaded_error` with `Retry-After`, RSS high-water from the cgroup. The gateway's own budget, sized for one body copy instead of Node's three | `src/sse/services/memoryAdmission.js`, `open-sse/config/runtimeConfig.js` |
| `internal/combo` | Combo lookup, member resolution through node prefixes, nesting up to depth 4 with a cycle check, `fallback` strategy (every member error falls through), the 5 s transient wait rule, the combo limit hold | `open-sse/services/combo.js`, `src/sse/services/model.js`, `src/lib/db/repos/combosRepo.js`, `chat.ts` combo branch |
| `internal/accounts` | Connection listing and filtering (locks, quota, plan); `fill-first`, `round-robin` with stickiness, `soonest-reset`; prompt-cache affinity keys, warm-key preference and the wait (`CACHE_AFFINITY_*`); 429 and error locks with exponential backoff from `ERROR_RULES`; lock clearing on stream start; header-timeout and same-request-error stops; dead-key evidence, demotion, probes and auto-disable; model hang | `src/sse/services/auth.js`, `open-sse/services/accountFallback.js`, `open-sse/config/errorConfig.js`, `open-sse/services/cacheAffinity.js`, `open-sse/utils/sessionManager.js`, `open-sse/services/modelHang.js`, `spreadLeases.js`, `src/lib/db/repos/connectionsRepo.js`, `chat.ts` account loop |
| `internal/claudeprep` | The request rewrite: `stripContentTypes`, `normalizeThinkingConfig`, tool-call id repair, `applyThinking` from model capabilities, `prepareClaudeRequest` (max-tokens clamp, empty-block drops, `cache_control` reset and re-placement, message and tool repair, tool-choice relax), upstream model id, `dedupeTools` for Claude Code, `type:"custom"` tools, `temperature` strip, beta body fields, endpoint overrides, `finalizeBody` | `open-sse/translator/index.ts`, `open-sse/translator/formats/claude.js`, `open-sse/translator/concerns/thinkingUnified.js`, `open-sse/translator/concerns/paramSupport.js`, `open-sse/services/provider.js`, `open-sse/config/providerModels.js`, `open-sse/handlers/chatCore.js` (prep steps), `open-sse/handlers/chatCore/endpointOverrides.ts`, `src/shared/utils/endpointOverrides.ts`, `open-sse/executors/default.js` |
| `internal/upstream` | Runtime transport (base URL suffix, `x-api-key` plus `Authorization`, `anthropic-version`, `anthropic-beta` merge and filtering, learned `droppedBetas` and the two beta retries); per-status retries; the 240 s headers budget; per-connection proxy pools and env proxies; body bytes reused across keys | `open-sse/executors/base.js`, `open-sse/executors/default.js`, `open-sse/utils/proxyFetch.js`, `open-sse/utils/headersTimeout.js`, `src/lib/network/connectionProxy.js` |
| `internal/stream` | Early SSE headers after `STREAM_EARLY_HEADERS_MS` with keepalives; the error event after early headers; pass-through relay with the short-id fix and the trailing `data: [DONE]`; usage from `message_start` and `message_delta`; stall abort; disconnect handling with the 500 ms grace; abort billing floor | `open-sse/utils/earlyHeaders.js`, `open-sse/utils/stream.js`, `open-sse/utils/streamHandler.js`, `open-sse/utils/usageTracking.js`, `open-sse/handlers/chatCore/streamingHandler.js` |
| `internal/usage` | Cost from user pricing overrides, then the built-in tables; the usage transaction (`usageHistory`, `usageDaily`, `_meta`, `apiKeys` spend); request-detail rows (5 KB or 128 KB previews, gzip full copies, newest 25, batching) | `src/lib/db/repos/usageRepo.js`, `src/lib/db/repos/pricingRepo.js`, `open-sse/providers/pricing.js`, `src/lib/requestDetail.js`, `src/lib/db/repos/requestDetailsRepo.js` |
| `internal/db` | Driver, pragmas, schema manifest and guard, `data_version` and generation watcher, the batched writer | `src/lib/db/driver.js`, `src/lib/db/schema.js`, `src/lib/db/migrate.js` |

Phase 2 leaves out the `fusion` and `round-robin` combo strategies, other client formats, Codex session affinity, side-search hooks and every other provider. A request that needs any of them goes to Node.

### Risks

- **Byte-exact request preparation.** A one-byte difference in the upstream body can silently halve prompt-cache hits and double cost. The transform tests run over a large corpus and the shadow compare runs before any canary. The Go JSON handling must keep key order and number text from the client, so it edits a raw-preserving representation and never round-trips through `map[string]any`.
- **SQLite lock contention freezing Node.** Covered by the short-transaction, batched-writer and no-open-reader rules above. A CI stress job will hammer both processes and assert Node's event-loop lag stays under 50 ms.
- **Split memory state.** If a provider is half native and half proxied, for example during a rollout or when a request falls back to Node, the two processes keep separate affinity and evidence maps. Cache affinity then gets worse for those requests, and dead-key evidence builds more slowly. Locks are unaffected because they live in the database. Rollouts flip a provider whole.
- **Drift as Node changes.** Every PR that touches a file in the map above must update the Go port or mark the route proxy-only. A CI job will fail a PR that changes a mapped file without touching `gateway/` or a `GATEWAY_PROXY_ONLY` list.
- **Two memory budgets in one 2 GiB cap.** Admission budgets for both processes have to add up under the cap, with Go's counted at its real single-copy weight.
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
