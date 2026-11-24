# 10router Architecture

_Last updated: 2026-02-06_

## Executive Summary

10router is a local AI routing gateway and dashboard built on Next.js.
It provides a single OpenAI-compatible endpoint (`/v1/*`) and routes traffic across multiple upstream providers with translation, fallback, token refresh, and usage tracking.

Core capabilities:

- OpenAI-compatible API surface for CLI/tools
- Request/response translation across provider formats
- Model combo fallback (multi-model sequence)
- Account-level fallback (multi-account per provider)
- OAuth + API-key provider connection management
- Local persistence for providers, keys, aliases, combos, settings, pricing
- Usage/cost tracking and request logging
- Optional cloud sync for multi-device/state sync

Primary runtime model:

- Next.js app routes under `src/app/api/*` implement both dashboard APIs and compatibility APIs
- A shared SSE/routing core in `src/sse/*` + `open-sse/*` handles provider execution, translation, streaming, fallback, and usage

## Scope and Boundaries

### In Scope

- Local gateway runtime
- Dashboard configuration APIs (`/api/*`, behind the session login)
- The scoped management-key API (`/api/management/v1/*`, bearer management keys)
- Provider authentication and token refresh
- Request translation and SSE streaming
- Local state + usage persistence
- Optional cloud sync orchestration

### Out of Scope

- Cloud service implementation behind `NEXT_PUBLIC_CLOUD_URL`
- Provider SLA/control plane outside local process
- External CLI binaries themselves (Claude CLI, Codex CLI, etc.)

## High-Level System Context

```mermaid
flowchart LR
    subgraph Clients[Developer Clients]
        C1[Claude Code]
        C2[Codex CLI]
        C3[OpenClaw / Droid / Cline / Continue / Roo]
        C4[Custom OpenAI-compatible clients]
        BROWSER[Browser Dashboard]
    end

    subgraph Router[10router Local Process]
        API[V1 Compatibility API\n/v1/*]
        DASH[Dashboard config API\n/api/*]
        CORE[SSE + Translation Core\nopen-sse + src/sse]
        DB[(db.json)]
        UDB[(usage.json + log.txt)]
    end

    subgraph Upstreams[Upstream Providers]
        P1[OAuth Providers\nClaude/Codex/Gemini/Qwen/iFlow/GitHub/Kiro/Cursor/Antigravity]
        P2[API Key Providers\nOpenAI/Anthropic/OpenRouter/GLM/Kimi/MiniMax]
        P3[Compatible Nodes\nOpenAI-compatible / Anthropic-compatible]
    end

    subgraph Cloud[Optional Cloud Sync]
        CLOUD[Cloud Sync Endpoint\nNEXT_PUBLIC_CLOUD_URL]
    end

    C1 --> API
    C2 --> API
    C3 --> API
    C4 --> API
    BROWSER --> DASH

    API --> CORE
    DASH --> DB
    CORE --> DB
    CORE --> UDB

    CORE --> P1
    CORE --> P2
    CORE --> P3

    DASH --> CLOUD
```

## Core Runtime Components

## 1) API and Routing Layer (Next.js App Routes)

Main directories:

- `src/app/api/v1/*` and `src/app/api/v1beta/*` for compatibility APIs
- `src/app/api/*` for the dashboard's configuration APIs (session login)
- `src/app/api/management/v1/*` for the management-key API: scoped
  `10r-mgmt-…` bearer keys that list, create and delete client keys and
  provider keys (see `docs/MANAGEMENT_KEYS.md`). Not the same thing as the
  dashboard's configuration APIs above, which a management key can't reach.
- Next rewrites in `next.config.mjs` map `/v1/*` to `/api/v1/*`, and
  `/backend-api/codex/*` (plus the duplicated `/backend-api/codex/v1/*` some
  clients emit) to `/api/v1/codex/*` — the Codex-native ingress

Important compatibility routes:

- `src/app/api/v1/chat/completions/route.js`
- `src/app/api/v1/messages/route.js`
- `src/app/api/v1/responses/route.js`
- `src/app/api/v1/models/route.js`
- `src/app/api/v1/codex/*` — Codex-native ingress served at `/backend-api/codex`
  (`responses` and `responses/compact` both go through `routeCodexRequest` in
  `src/sse/services/codexIngress.ts`, which picks Codex, an auto combo with Codex
  accounts first, or the model as named, then call `handleChat` like the `/v1`
  routes. A compaction (`responses/compact`), and a later turn carrying Codex's
  encrypted compaction item, never get the auto combo: no other provider can
  read them, so for a model Codex serves they stay on `cx/`, and for one Codex
  doesn't serve they route as on `/v1`; `[...path]` acknowledges Codex's
  advisory side-calls). `models` serves the routed models in Codex's
  `{ "models": [...] }` shape (`src/lib/codex/modelCatalog.js`), which
  replaces Codex's own catalog once it decodes. A routed model that Codex's own
  lookup matches to a model in Codex's bundled catalog (vendored in
  `open-sse/config/codex/`, refreshed with `scripts/vendor-codex-catalog.mjs`),
  such as `cx/gpt-5.5` or `gh/gpt-5.5`, gets that entry under its routed id.
  Any other model gets a generic entry with Codex's generic prompt and, if it
  can call tools, a shell and the freeform `apply_patch` tool. Codex's bundled
  models also stay in under their bare names, hidden from the picker. The same
  body carries an OpenAI-shaped `data` list.
- `src/app/api/v1/messages/count_tokens/route.js`
- `src/app/api/v1/key/route.js` — `GET /v1/key`: the calling key's own budget,
  spend, allowed models and expiry (see `docs/API_KEY_BUDGETS.md`)
- `src/app/api/v1beta/models/route.js`
- `src/app/api/v1beta/models/[...path]/route.js`

Management domains:

- Auth/settings: `src/app/api/auth/*`, `src/app/api/settings/*`
- Management keys: `src/app/api/management-keys/*` (dashboard side, session
  checked in the route too) and `src/app/api/management/v1/*` (the keys' own
  API). In `src/dashboardGuard.js`, `/api/management/v1/*` is the only path
  that takes a management key, as `Authorization: Bearer`, and nothing else; a
  token carrying `10r-mgmt-` is refused on every inference prefix, loopback included.
- Providers/connections: `src/app/api/providers*`
- Provider nodes: `src/app/api/provider-nodes*`
- OAuth: `src/app/api/oauth/*`
- Keys/aliases/combos/pricing: `src/app/api/keys*`, `src/app/api/models/alias`, `src/app/api/combos*`, `src/app/api/pricing`
- Usage: `src/app/api/usage/*`
- Sync/cloud: `src/app/api/sync/*`, `src/app/api/cloud/*`
- CLI tooling helpers: `src/app/api/cli-tools/*`

## 2) SSE + Translation Core

Main flow modules:

- Entry: `src/sse/handlers/chat.ts`
- Core orchestration: `open-sse/handlers/chatCore.js`
- Provider execution adapters: `open-sse/executors/*`
- Format detection/provider config: `open-sse/services/provider.js`
- Model parse/resolve: `src/sse/services/model.js`, `open-sse/services/model.js`
- Account fallback logic: `open-sse/services/accountFallback.js`
- Translation registry: `open-sse/translator/index.ts`
- Stream transformations: `open-sse/utils/stream.js`, `open-sse/utils/streamHandler.js`
- Usage extraction/normalization: `open-sse/utils/usageTracking.js`

## 3) Persistence Layer

Primary state DB:

- `src/lib/localDb.js`
- file: `${DATA_DIR}/db.json` (or `~/.9router/db.json` when `DATA_DIR` is unset) (the directory name is unchanged from the previous release for backward compatibility)
- entities: providerConnections, providerNodes, modelAliases, combos, apiKeys, settings, pricing

Usage DB:

- `src/lib/usageDb.js`
- files: `~/.9router/usage.json`, `~/.9router/log.txt`
- note: currently independent from `DATA_DIR`

## 4) Auth + Security Surfaces

- Dashboard cookie auth: `src/proxy.js`, `src/app/api/auth/login/route.js`
- API key generation/verification: `src/shared/utils/apiKey.js`
- Client API key limits (budget, model allowlist, expiry), checked by every
  `/v1` handler before any upstream call: `src/sse/services/keyLimits.js`.
  Spend is a running total per key, updated with each usage row
  (`docs/API_KEY_BUDGETS.md`)
- Provider secrets persisted in `providerConnections` entries
- Upstream proxies (`src/lib/network/proxyRouting.ts`, `connectionProxy.ts`, applied in `open-sse/utils/proxyFetch.js`): each request resolves Account (`providerSpecificData.proxyPoolId`) → Provider (`settings.providerStrategies[provider].proxyPoolId`) → Global (`settings.globalProxyPoolId`) → env proxy variables. Each layer is unset (inherit), `__direct__` or a proxy pool id; the most specific set layer wins. A layer naming a pool that is off or gone blocks the request rather than falling through. Direct skips the env proxy. Embeddings, image, video, TTS/STT, search and web fetch handlers, Devin CLI's subprocess and Cursor's HTTP/2 AgentService text path don't use account proxies yet (only the env proxy, or none); chatCore still refuses a blocked account before any executor runs.

## 5) Cloud Sync

- Scheduler init: `src/lib/initCloudSync.js`, `src/shared/services/initializeCloudSync.js`
- Periodic task: `src/shared/services/cloudSyncScheduler.js`
- Control route: `src/app/api/sync/cloud/route.js`

## Request Lifecycle (`/v1/chat/completions`)

```mermaid
sequenceDiagram
    autonumber
    participant Client as CLI/SDK Client
    participant Route as /api/v1/chat/completions
    participant Chat as src/sse/handlers/chat
    participant Core as open-sse/handlers/chatCore
    participant Model as Model Resolver
    participant Auth as Credential Selector
    participant Exec as Provider Executor
    participant Prov as Upstream Provider
    participant Stream as Stream Translator
    participant Usage as usageDb

    Client->>Route: POST /v1/chat/completions
    Route->>Chat: handleChat(request)
    Chat->>Chat: API key check, then the key's limits (budget, model allowlist, expiry; keyLimits.js)
    Chat->>Model: parse/resolve model or combo

    alt Combo model
        Chat->>Chat: iterate combo models (handleComboChat)
    end

    Chat->>Auth: getProviderCredentials(provider)
    Auth-->>Chat: active account + tokens/api key

    Chat->>Core: handleChatCore(body, modelInfo, credentials)
    Core->>Core: detect source format
    Core->>Core: translate request to target format
    Core->>Exec: execute(provider, transformedBody)
    Exec->>Prov: upstream API call
    Prov-->>Exec: SSE/JSON response
    Exec-->>Core: response + metadata

    alt 401/403
        Core->>Exec: refreshCredentials()
        Exec-->>Core: updated tokens
        Core->>Exec: retry request
    end

    Core->>Stream: translate/normalize stream to client format
    Stream-->>Client: SSE chunks / JSON response

    Stream->>Usage: extract usage + persist history/log
```

## Combo + Account Fallback Flow

```mermaid
flowchart TD
    A[Incoming model string] --> B{Is combo name?}
    B -- Yes --> C[Load combo models sequence]
    B -- No --> D[Single model path]

    C --> E[Try model N]
    E --> F[Resolve provider/model]
    D --> F

    F --> G[Select account credentials]
    G --> H{Credentials available?}
    H -- No --> I[Return provider unavailable]
    H -- Yes --> J[Execute request]

    J --> K{Success?}
    K -- Yes --> L[Return response]
    K -- No --> M{Fallback-eligible error?}

    M -- No --> N[Return error]
    M -- Yes --> O[Mark account unavailable cooldown]
    O --> P{Another account for provider?}
    P -- Yes --> G
    P -- No --> Q{In combo with next model?}
    Q -- Yes --> E
    Q -- No --> R[Return all unavailable]
```

The combo models come from a combo the user made (`getComboModels`), else from a list the route already resolved (the Codex ingress hands `handleChat` its Codex-first auto combo as `autoCombo`), else from an auto combo of every connected provider serving a bare id (`resolveAutoCombo` in `src/sse/services/autoCombo.ts`).

Fallback decisions are driven by `open-sse/services/accountFallback.js` using status codes and error-message heuristics.

On a custom (OpenAI-/Anthropic-compatible) endpoint, a request error every key would refuse ends the account walk early: once `SAME_REQUEST_ERROR_STOP_AFTER` (2) accounts of one model answered a request with the same request error (the upstream's message, read out of a JSON body when there is one, compared lowercased, digits as `#`, whitespace collapsed; `open-sse/services/sameRequestError.ts`), the account loop in `src/sse/handlers/chat.ts` returns that error instead of trying the next account. A combo then moves on to its next model as for any final failure. It's an allowlist: only a 413, or a 400/422 whose message matches `SAME_REQUEST_ERROR_PATTERNS` in `open-sse/config/errorConfig.js` (the context window or the model's token limit, a rejected tool schema, a thinking budget), counts. Any other 4xx may be about the account (these keys aren't locked for it), so it keeps the walk. So do 401/403/404/429, 5xx and header timeouts, and so does a message or body that names a bad key, billing, a rate or usage limit or quota, a limit on one key, account, organization or plan (`SAME_REQUEST_ERROR_KEY_LIMIT`: per minute or day, TPM, daily, tier, upgrade, "your organization", "your subscription", ...), or a refusal of one model or operation. Keys that reach one upstream the same way (same proxy or relay, or none) are assumed to be on the same tier, so their messages need only match up to numbers. When any active key has its own base URL, the keys' upstream fields differ, or they go through different proxies or relays (`keysShareOneUpstream` in `src/sse/services/auth.js`, using `networkPath`'s transport), their limits may differ: a proxy or relay has its own body limit and can answer a 413 itself. There at least `max(SAME_REQUEST_ERROR_STOP_AFTER, 2)` distinct upstreams (`src/sse/services/connectionUpstream.ts`, which `auth.js` uses too; a base URL compared canonically: scheme and host lowercased, a default port dropped, trailing slashes and a pasted `/chat/completions`, `/messages` or `/responses` dropped, path case and query string kept; dead-key evidence uses the same comparison) must give the very same message, numbers included: the extracted upstream message, only trimmed, lowercased and stripped of a relay's request id. That message must be a context or token limit (`SAME_REQUEST_ERROR_LIMIT_PATTERNS`) naming both sizes, two runs of 4+ digits such as "12345 tokens > 10000 maximum", and never a 413. So "> 200000 maximum" from one and "> 1000000 maximum" from another keeps the walk, and so do two keys on one upstream while a third key is elsewhere, a schema error with a tool index, and a message whose only digits are a model name. `SAME_REQUEST_ERROR_STOP_AFTER=1` stops at the first error only when the keys share one upstream reached the same way (same proxy or relay). A pool that mixes tiers behind one URL needs `SAME_REQUEST_ERROR_STOP_AFTER=0`, which is global: it turns the stop off for every node. A 413 counts whatever it says but goes through the same vetoes, and a relay's "(request id: ...)" in the message is dropped before comparing. Built-in providers keep walking every key, since their accounts can differ in plan or region.

Prompt-cache affinity (`open-sse/services/cacheAffinity.js`) shapes step G for requests that ask for a prompt cache. Upstream caches are per account, so each conversation remembers its warm keys: the ones that served it within the cache TTL. A conversation is identified by a hash of the client key, session id, system prompt, instructions and first message. In `getProviderCredentials`, fill-first and soonest-reset keep their own pick, so a better usable key is never skipped. Fill-first ranks by priority. Soonest-reset ranks by reset, then priority; a known reset ranks ahead of an unknown one, and two unknown resets fall to priority. Round-robin takes the conversation's most recently used usable warm key and doesn't update the rotation for it. When the pick isn't warm and the prompt is large (`CACHE_AFFINITY_MIN_TOKENS`), it goes through the servable warm keys that are only limit-locked, soonest lock end first. Each one's retry time is lock end + `lockSlackMs` + jitter (one draw per selection). It returns `warmRetryAtMs` for the first one whose earliest retry, lock end + `lockSlackMs`, fits the remaining `CACHE_AFFINITY_MAX_WAIT_MS` (counted per request and model). It skips a candidate when a servable key the strategy ranks ahead of it is usable or frees up (lock or quota block over) within another `lockSlackMs` of that earliest retry. The jitter is then cut to the budget, and to `lockSlackMs` before the first better-ranked key frees up. The same margin on both sides absorbs late timers and the time selection takes before it reads the locks. Round-robin ranks none, so nothing overtakes there. The account loop in `src/sse/handlers/chat.ts` then sleeps until that time (abort-aware) and selects again. A warm key's own short 429 is recorded as a failure but not excluded, so the next selection can wait for it. Codex uses its own opt-in session pin (`open-sse/services/sessionAffinity.js`) instead.

## OAuth Onboarding and Token Refresh Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant UI as Dashboard UI
    participant OAuth as /api/oauth/[provider]/[action]
    participant ProvAuth as Provider Auth Server
    participant DB as localDb
    participant Test as /api/providers/[id]/test
    participant Exec as Provider Executor

    UI->>OAuth: GET authorize or device-code
    OAuth->>ProvAuth: create auth/device flow
    ProvAuth-->>OAuth: auth URL or device code payload
    OAuth-->>UI: flow data

    UI->>OAuth: POST exchange or poll
    OAuth->>ProvAuth: token exchange/poll
    ProvAuth-->>OAuth: access/refresh tokens
    OAuth->>DB: createProviderConnection(oauth data)
    OAuth-->>UI: success + connection id

    UI->>Test: POST /api/providers/[id]/test
    Test->>Exec: validate credentials / optional refresh
    Exec-->>Test: valid or refreshed token info
    Test->>DB: update status/tokens/errors
    Test-->>UI: validation result
```

Refresh during live traffic runs inside the chat, image, embeddings and video cores (`open-sse/handlers/chatCore.js`, `imageGenerationCore.js`, `embeddingsCore.js`, `videoCore.js`), through the executor's `refreshCredentials()` (video calls `refreshTokenByProvider()`), and each applies the result to the request's copy with `applyRefreshedCredentials()`. Those refreshes, the proactive one in `checkAndRefreshToken()`, usage polling, the connection test (with its `refreshTokenUsed` check), model listing and the translator's send all save through `updateProviderCredentials()` (`src/sse/services/credentialSave.js`). It writes only the fields the result carries: `updateProviderConnection()` applies the result's `providerSpecificData` over the stored row and stamps `lastRefreshAt` when the access token changed, in one transaction.

## Cloud Sync Lifecycle (Enable / Sync / Disable)

```mermaid
sequenceDiagram
    autonumber
    participant UI as Endpoint Page UI
    participant Sync as /api/sync/cloud
    participant DB as localDb
    participant Cloud as External Cloud Sync
    participant Claude as ~/.claude/settings.json

    UI->>Sync: POST action=enable
    Sync->>DB: set cloudEnabled=true
    Sync->>DB: ensure API key exists
    Sync->>Cloud: POST /sync/{machineId} (providers/aliases/combos/keys)
    Cloud-->>Sync: sync result
    Sync->>Cloud: GET /{machineId}/v1/verify
    Sync-->>UI: enabled + verification status

    UI->>Sync: POST action=sync
    Sync->>Cloud: POST /sync/{machineId}
    Cloud-->>Sync: remote data
    Sync->>DB: update newer local tokens/status
    Sync-->>UI: synced

    UI->>Sync: POST action=disable
    Sync->>DB: set cloudEnabled=false
    Sync->>Cloud: DELETE /sync/{machineId}
    Sync->>Claude: switch ANTHROPIC_BASE_URL back to local (if needed)
    Sync-->>UI: disabled
```

Periodic sync is triggered by `CloudSyncScheduler` when cloud is enabled.

## Data Model and Storage Map

```mermaid
erDiagram
    SETTINGS ||--o{ PROVIDER_CONNECTION : controls
    PROVIDER_NODE ||--o{ PROVIDER_CONNECTION : backs_compatible_provider
    PROVIDER_CONNECTION ||--o{ USAGE_ENTRY : emits_usage

    SETTINGS {
      boolean cloudEnabled
      number stickyRoundRobinLimit
      boolean requireLogin
      string password_hash
    }

    PROVIDER_CONNECTION {
      string id
      string provider
      string authType
      string name
      number priority
      boolean isActive
      string apiKey
      string accessToken
      string refreshToken
      string expiresAt
      string testStatus
      string lastError
      string rateLimitedUntil
      json providerSpecificData
    }

    PROVIDER_NODE {
      string id
      string type
      string name
      string prefix
      string apiType
      string baseUrl
    }

    MODEL_ALIAS {
      string alias
      string targetModel
    }

    COMBO {
      string id
      string name
      string[] models
    }

    API_KEY {
      string id
      string name
      string key
      string machineId
      boolean isActive
    }

    USAGE_ENTRY {
      string provider
      string model
      number prompt_tokens
      number completion_tokens
      string connectionId
      string timestamp
    }
```

Physical storage files:

- main state: `${DATA_DIR}/db.json` (or `~/.9router/db.json`)
- usage stats: `~/.9router/usage.json`
- request log lines: `~/.9router/log.txt`
- optional translator/request debug sessions: `<repo>/logs/...`

## Deployment Topology

```mermaid
flowchart LR
    subgraph LocalHost[Developer Host]
        CLI[CLI Tools]
        Browser[Dashboard Browser]
    end

    subgraph ContainerOrProcess[10router Runtime]
        Next[Next.js Server\nPORT=20128]
        Core[SSE Core + Executors]
        MainDB[(db.json)]
        UsageDB[(usage.json/log.txt)]
    end

    subgraph External[External Services]
        Providers[AI Providers]
        SyncCloud[Cloud Sync Service]
    end

    CLI --> Next
    Browser --> Next
    Next --> Core
    Next --> MainDB
    Core --> MainDB
    Core --> UsageDB
    Core --> Providers
    Next --> SyncCloud
```

Restarts: on SIGTERM/SIGINT `custom-server.js` drains (`server-drain.js`). It closes the listening socket, so new connections are refused for the whole drain, and waits up to `SHUTDOWN_DRAIN_TIMEOUT_MS` for in-flight model requests before running the app's own shutdown listeners and exiting. It only helps if the container's stop grace period is longer than that timeout. `installExitRecorder` (also in `server-drain.js`) logs an `[Exit]` line on every exit the process makes itself, with the code, uptime, memory, open requests and its cause: the caller of `process.exit()`, an uncaught exception or unhandled rejection (Node's `_fatalException` on the stack), or "the event loop ran empty". Its listener is prepended, so another `exit` listener's `process.exit()` can't skip it. It and the drain's `[Shutdown]` lines go through `writeLineSync`: `fs.writeSync` to stderr (fd 2), retried on `EAGAIN` for up to a second in all, with `console.log` as the fallback. `console.log` to a pipe is asynchronous on Linux, and a stdout pipe the request log has filled would have queued the line until the exit dropped it. This holds when stderr is its own pipe (Docker without a tty, the CLI's piped mode); when stderr shares stdout's pipe (`2>&1 | tee`), the line can land in the middle of a request line, wait behind the request log, or fall back to `console.log`. A restart with no `[Exit]` line was a kill from outside, such as the kernel's OOM killer. Never run two instances on one `DATA_DIR` to overlap a restart: SQLite / sql.js writes are last-writer-wins, and rotating OAuth refresh tokens would be lost.

Memory admission: every chat request (`handleChat`, and the Codex and compact routes before they read the body) passes `src/sse/services/memoryAdmission.js` first, which keeps a burst of big prompts from taking the process past its memory limit. See [MEMORY_ADMISSION.md](MEMORY_ADMISSION.md).

## Module Mapping (Decision-Critical)

### Route and API Modules

- `src/app/api/v1/*`, `src/app/api/v1beta/*`: compatibility APIs
- `src/app/api/providers*`: provider CRUD, validation, testing
- `src/app/api/provider-nodes*`: custom compatible node management
- `src/app/api/oauth/*`: OAuth/device-code flows
- `src/app/api/keys*`: local API key lifecycle
- `src/app/api/models/alias`: alias management
- `src/app/api/combos*`: fallback combo management
- `src/app/api/pricing`: pricing overrides for cost calculation
- `src/app/api/usage/*`: usage and logs APIs
- `src/app/api/sync/*` + `src/app/api/cloud/*`: cloud sync and cloud-facing helpers
- `src/app/api/cli-tools/*`: local CLI config writers/checkers

### Routing and Execution Core

- `src/sse/handlers/chat.ts`: combo handling, account selection loop (the JSON body is read and checked by `src/sse/utils/requestBody.js`)
- `open-sse/handlers/chatCore.js`: translation, executor dispatch, retry/refresh handling, stream setup
- `open-sse/executors/*`: provider-specific network and format behavior

### Translation Registry and Format Converters

- `open-sse/translator/index.ts`: translator registry and orchestration
- Request translators: `open-sse/translator/request/*`
- Response translators: `open-sse/translator/response/*`
- Format constants: `open-sse/translator/formats.js`

### Persistence

- `src/lib/localDb.js`: persistent config/state
- `src/lib/usageDb.js`: usage history and rolling request logs

## Provider Executor Coverage

Specialized executors:

- `antigravity`
- `gemini-cli`
- `github`
- `kiro`
- `codex`
- `cursor`

Default executor path:

- all other providers (including compatible node providers) use `open-sse/executors/default.js`

## Format Translation Coverage

Detected source formats include:

- `openai`
- `openai-responses`
- `claude`
- `gemini`

Target formats include:

- OpenAI chat/Responses
- Claude
- Gemini/Gemini-CLI/Antigravity envelope
- Kiro
- Cursor

Translations are selected dynamically based on source payload shape and provider target format.

## Failure Modes and Resilience

## 1) Account/Provider Availability

- provider account cooldown on transient/rate/auth errors
- account fallback before failing request
- combo model fallback when current model/provider path is exhausted
- an upstream that sends no response headers in time fails as a 504 (`HEADERS_TIMEOUT` in `open-sse/config/errorConfig.js`): one request tries at most one more key after it, and streaming header timeouts from two requests on two keys of one provider/model, with no success between, mark that model hung (`open-sse/services/modelHang.js`, in memory per process), so new requests for it fail at once (a 504 with Retry-After) until a single probe request, sent to keys that haven't stalled, gets an answer; the request that marks it, if it already sent a stream's early headers, ends with a retryable in-stream error instead
- on a custom (OpenAI-/Anthropic-compatible) endpoint, a request error that `SAME_REQUEST_ERROR_STOP_AFTER` (2) keys of one model answered with the same message is returned at once instead of trying the remaining keys (`open-sse/services/sameRequestError.ts`); only a 413, or a 400/422 whose message matches `SAME_REQUEST_ERROR_PATTERNS` (context or token overflow, a rejected tool schema, a thinking budget), counts, and none whose text names a limit on the key, organization or plan (a 413 included); when the keys don't all reach one upstream, at least `max(SAME_REQUEST_ERROR_STOP_AFTER, 2)` distinct upstreams must give the very same context or token limit message naming both sizes (never a 413); built-in providers keep walking every key; for a pool mixing tiers behind one URL set `SAME_REQUEST_ERROR_STOP_AFTER=0`, which turns the stop off for every node

## 2) Token Expiry

- pre-check and refresh with retry for refreshable providers
- 401/403 retry after refresh attempt in core path

## 3) Stream Safety

- disconnect-aware stream controller
- translation stream with end-of-stream flush and `[DONE]` handling
- usage estimation fallback when provider usage metadata is missing

## 4) Cloud Sync Degradation

- sync errors are surfaced but local runtime continues
- scheduler has retry-capable logic, but periodic execution currently calls single-attempt sync by default

## 5) Data Integrity

- DB shape migration/repair for missing keys
- corrupt JSON reset safeguards for localDb and usageDb

## Observability and Operational Signals

Runtime visibility sources:

- console logs from `src/sse/utils/logger.js`
- per-request usage aggregates in `usage.json`
- textual request status log in `log.txt`
- optional deep request/translation logs under `logs/` when `ENABLE_REQUEST_LOGS=true`. `open-sse/utils/requestLogger.js` masks credential headers (last 4 characters kept) and redacts secret query params in logged URLs, using the shared rules in `open-sse/utils/redact.js` (constants in `open-sse/config/redactionConstants.js`); the directory is `0700` and every file, streamed chunks included, `0600`
- dashboard usage endpoints (`/api/usage/*`) for UI consumption

## Security-Sensitive Boundaries

- Who a request comes from: `custom-server.js` decides it from the TCP socket and stamps `x-9r-real-ip` / `x-9r-alt-ips` / `x-9r-via-proxy` / `x-9r-proxy-hop` / `x-9r-via-tunnel` with a per-process peer token, plus the raw TCP peer as `x-9r-socket-ip` / `x-9r-socket-port` (behind the Go gateway, the client peer it hands over with its token; see `docs/GO_GATEWAY.md`), which only `/api/health` reads (for the CLI launcher's readiness proof) and nothing keys on or trusts; `src/` trusts those stamps only with the token (`src/lib/auth/trustedPeer.js`). A client on this machine (`isOnThisMachine`) is a loopback socket with no forwarding header (`X-Forwarded-*`, `X-Real-IP`, `Forwarded`, `True-Client-IP`, Cloudflare's `CF-Connecting-IP`/`Cf-Ray`, Tailscale Funnel's header) and `TRUST_PROXY` not `true`; it alone gets keyless `/v1`, the local-only routes and private endpoint URLs. `Host` only rules a request out (a non-loopback one is remote), since the client chooses it: a forwarder that adds no forwarding header (socat, `ssh -R`, a TCP tunnel, nginx with neither `X-Forwarded-For` nor `X-Real-IP` set) needs `TRUST_PROXY=true`. The password login keys (`clientKeysFor`) are the socket for a direct peer. Behind a loopback proxy, or a peer `TRUST_PROXY` lists as IPs/CIDRs that sent a forwarding header (one that sent none is a direct peer, and no `x-9r-proxy-hop`), they are the rightmost `X-Forwarded-For` entry that is a non-loopback IP and the `X-Real-IP` (both when both are sent, since either may be the client's), `CF-Connecting-IP` only when neither is sent, else `unknown`; behind `TRUST_PROXY=true`, always `unknown`. `x-9r-via-tunnel` marks a loopback peer whose `Host` ends in `.trycloudflare.com` or `.ts.net`
- Password login lockout (`src/lib/auth/loginLimiter.ts`, `login/route.js`): per key, 5 failures (attempts in flight included) lock for 30 s, then 2 m, 10 m, 30 m; failures reset an hour after the last one. A login with two keys counts against both, in a table of its own (one key is the client's to choose, so its failures must not lock that address's one-key logins), and is refused while either key is locked in either table; a one-key login answers only to one-key locks. Keys: the client's IPv4 address or IPv6 /64; `local` for every password login from this machine (so remote clients can't lock it); `unknown` for every login with no known address, which locks for a fixed 15 s and never escalates. There is no global limit. The setup token and SAML ACS routes take the same one or two keys with the older check-then-record calls
- Browser requests (`src/dashboardGuard.js`): a request another site started (`Sec-Fetch-Site: cross-site`/`same-site` with no `Origin`) is never local. One whose `Origin` isn't this server (same host, and same port unless `Host` has none; `Sec-Fetch-Site: same-origin` settles it) gets nothing from a session cookie or `requireLogin=false`. With login off, the API answers only loopback names, IP literals and the tunnel, Tailscale, `BASE_URL`/`NEXT_PUBLIC_BASE_URL` and `ALLOWED_HOSTS` hosts (DNS rebinding), and no loopback `Host` stamped `x-9r-proxy-hop` with either value (`loopback` for a loopback peer that isn't local, `listed` for a `TRUST_PROXY`-listed peer that sent a forwarding header), which a Host-rewriting proxy sends for any name; an IP-literal `Host` stamped `x-9r-proxy-hop: listed` (a `TRUST_PROXY`-listed peer that sent a forwarding header, not a same-host proxy, whose upstream is loopback) counts only when `ALLOWED_HOSTS` or `BASE_URL`/`NEXT_PUBLIC_BASE_URL` names it. A GET to a local-only route without the CLI token needs same-origin proof. Every page sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`. With tunnel dashboard access off, the tunnel and Tailscale hosts, and any request stamped `x-9r-via-tunnel`, get 403 on every non-public `/api/*` and a redirect from `/dashboard`
- JWT secret (`JWT_SECRET`, at least 32 characters; shorter values and documented placeholders are ignored in favour of the generated `$DATA_DIR/jwt-secret`, see `src/lib/auth/authSecret.js`) secures dashboard session cookie verification/signing
- Dashboard session lifetime (`src/lib/auth/dashboardSession.js`): the `auth_token` cookie's `Max-Age` and the JWT's `exp` are both `DASHBOARD_SESSION_MAX_AGE_SEC` (30 days), so a sign-in survives browser restarts. A restricted `pwChange` session is a browser-session cookie with a 24-hour `exp` (`PASSWORD_CHANGE_SESSION_TTL_SEC`). Revocation (below) ends a session before its `exp`. Changing the SSO settings or `SSO_ALLOWED_USERS`, or rotating `INITIAL_PASSWORD` in the environment, starts no new epoch, so sessions from before stay valid until their `exp`; log out to end them. Restoring a backup by hand brings back its older epoch, and the sessions revoked since then with it. Cookies aren't scoped by port, so the browser also sends `auth_token` to other servers on the same host for those 30 days
- First-run bootstrap: there is **no default dashboard password**. An unclaimed
  install mints a one-time setup token (`$DATA_DIR/setup-token.json`, 0600),
  prints it to the server console, and locks every dashboard/API route until
  `/setup` is completed with that token. The token expires 5 minutes after it
  is minted (startup, or a CLI password reset); restarting mints a new one, and
  claiming consumes it atomically. `requireLogin=false` does not bypass this.
  `INITIAL_PASSWORD` (optional, min 8 chars) is an explicit headless bootstrap
  and skips the setup flow. Installs predating this flow are stamped
  `legacyDefaultPassword` in `_meta` and can still log in on the old default
  until the password is changed; that session carries a `pwChange` claim which the guard restricts to
  `/api/auth/change-password`, logout and status, so the forced change cannot be skipped.
- SSO: OIDC and SAML logins give the single admin role, so `SSO_ALLOWED_USERS` is the only way to narrow who gets in. SAML start keeps no server state: it puts the AuthnRequest ID and a 10-minute expiry in the `saml_state` cookie, HMAC-signed with the session secret (`src/lib/auth/authSecret.js`). ACS lets node-saml redeem only that request, and each process refuses a request it already used (that record is in memory, so another instance, or the same one after a restart, could take a captured response and cookie once more within the 10 minutes). So SAML needs HTTPS (for the `SameSite=None` cookie), and several instances need the same `JWT_SECRET`. With SAML, an `SSO_ALLOWED_USERS` email entry trusts the email the IdP asserts
- API key HMAC secret (`API_KEY_SECRET`) secures generated local API key format
- Session revocation: each dashboard JWT carries the epoch it was issued under (`sep`). The epoch is `dashboardSessionEpoch` in `_meta` (`src/lib/db/helpers/sessionEpoch.js`), never in settings and never exported, and a DB import never copies it in. Logout (by a session the dashboard accepts), a password change, change-password, Reset Password, setup completion and an import that changes the password start a new epoch, which ends every session; the browser that changed the password is signed in again (`reissueDashboardSession`). Sessions from before the first epoch have no `sep` and stay valid until then. The epoch is per database: instances behind one URL with separate databases revoke only their own sessions
- Provider secrets (API keys/tokens) are persisted in local DB. `src/lib/db/paths.js` creates `db/` and `backups/` `0700` (tightening an existing `db/`), and the driver sets `data.sqlite`, `-wal`, `-shm` and leftover pre-SQLite JSON files (`db.json`, `usage.json`, `disabledModels.json`, `request-details.json`) to `0600` on start; sql.js writes the file `0600` from its first save. Safety backups in `db/backups/` (which copy `_meta`, session epoch included) are `0700`/`0600`. A `DATA_DIR` the operator created keeps its mode. Everything is best-effort and skipped on Windows. Provider API responses (`/api/providers`, `/api/providers/[id]`) leave out the key, OAuth tokens and any `providerSpecificData` field named like a secret (`*Token`, `*Secret`, `*Password`, `*Cookie`, `*ApiKey`); binary upstream bodies are logged and stored as `[binary N bytes]`
- CLI token (`x-9r-cli-token`, `src/lib/auth/cliToken.ts`): derived from the machine id, salt `9r-cli-auth` and `/auth/cli-secret`, the same way `cli/src/cli/api/client.js` derives it, and compared in constant time. CLI tool status routes return only the fields their cards read, never the host tools' other keys, tokens or headers
- Cloud sync endpoints rely on API key auth + machine id semantics

## Environment and Runtime Matrix

Environment variables actively used by code:

- App/auth: `JWT_SECRET`, `INITIAL_PASSWORD`, `SSO_ALLOWED_USERS` (optional OIDC/SAML allowlist of emails, `@domain` suffixes or subject IDs; unset allows every IdP account; OIDC email entries only match an IdP-verified email, so list Entra ID users by subject ID; SAML email entries trust the asserted email, so prefer NameID entries where users can edit theirs)
- Storage: `DATA_DIR`
- Security hashing: `API_KEY_SECRET`, `MACHINE_ID_SALT`
- Reverse proxy: `TRUST_PROXY`. `true`: no loopback connection counts as local, so clients on this machine need an API key or the CLI token too, and every login through it keys on `unknown`; required for a forwarder on this machine that adds no forwarding header (socat, `ssh -R`, a TCP tunnel), since its clients choose their own `Host` and headers. A comma list of IPs and CIDRs: reverse proxies on other hosts or containers whose `X-Forwarded-For`/`X-Real-IP` are read like a same-host proxy's. A listed peer counts as a proxy only on a request with a forwarding header; send one on every location (nginx drops server-level `proxy_set_header` lines from a location that sets its own). A same-host proxy that sends `X-Forwarded-For`/`X-Real-IP` needs neither
- Login-off host allowlist: `BASE_URL` / `NEXT_PUBLIC_BASE_URL` and `ALLOWED_HOSTS` (comma list of names or URLs) name the hosts the open dashboard API answers besides loopback names, IP literals (not behind a listed proxy hop) and the tunnel hosts
- Logging: `ENABLE_REQUEST_LOGS`
- Sync/cloud URLing: `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_CLOUD_URL`
- Analytics (optional, build-time): `NEXT_PUBLIC_GA_ID`. A Google Analytics 4 measurement ID (`G-` followed by uppercase letters and digits); anything else, or unset, builds without analytics. `next.config.mjs` inlines it during `next build`, so setting it on a running server does nothing. The tag never loads on `/callback`.
- Outbound proxy: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and lowercase variants (the last proxy layer; see the upstream proxies note above)
- Endpoint detection: `DETECT_ANTHROPIC_FIRST_HINTS` (URL substrings that get Anthropic Messages probed first)
- Shutdown: `SHUTDOWN_DRAIN_TIMEOUT_MS` (default `180000`; `0`/`off`/`false` disables). How long `custom-server.js` waits on SIGTERM/SIGINT for in-flight model requests (`/v1*`, `/api/v1*`, `/v1beta*`, `/api/v1beta*`, `/responses`, `/systemone`, `/codex/*`, `/backend-api/codex/*`, Codex WebSocket turns, a budgeted key's post-hang-up usage read) before exiting; see `server-drain.js` and the README's deploy notes. The stop timeout of whatever stops the process (container grace period, PM2 `kill_timeout`, systemd `TimeoutStopSec`) must be longer than this, or it kills the process first.
- Memory admission: `INFLIGHT_BODY_BUDGET_MB` (default `900`; `0` disables), `INFLIGHT_QUEUE_WAIT_MS` (default `15000`), `INFLIGHT_RETRY_AFTER_S` (default `10`), `MEMORY_HIGH_WATER_MB` (default 80% of the cgroup memory limit, off without one; `0` disables), `MEMORY_HEAP_HIGH_WATER_PCT` (default `85`, percent of the V8 heap limit; `0` disables), `INFLIGHT_UNKNOWN_BODY_MB` (default `4`). See [MEMORY_ADMISSION.md](MEMORY_ADMISSION.md).
- Platform/runtime helpers (not app-specific config): `APPDATA`, `NODE_ENV`, `PORT`, `HOSTNAME`

## Known Architectural Notes

1. `usageDb` currently stores under `~/.9router` and does not follow `DATA_DIR`.
2. `/api/v1/route.js` returns a static model list and is not the main models source used by `/v1/models`.
3. Request logger writes full headers/body when enabled; treat log directory as sensitive.
4. Cloud behavior depends on correct `NEXT_PUBLIC_BASE_URL` and cloud endpoint reachability.

## Operational Verification Checklist

- Build from source: `cd /root/dev/10router && npm run build`
- Build Docker image: `cd /root/dev/10router && docker build -t 10router .`
- Start service and verify:
- `GET /api/settings`
- `GET /api/v1/models`
- CLI target base URL should be `http://<host>:20128/v1` when `PORT=20128`
