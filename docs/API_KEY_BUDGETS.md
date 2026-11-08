# API key budgets, model limits and expiry

The client API keys 10router issues (Endpoint page → API Keys) can each carry
three optional limits:

| Limit | Field | What happens when it's hit |
|---|---|---|
| Spend budget, in USD, over the key's lifetime or since its last reset | `budgetUsd` | `402`, before any upstream call |
| Model allowlist | `allowedModels` | `403` for a model not on the list |
| Expiry date | `expiresAt` | `401` once the date has passed |

A key with none of them set works exactly as keys did before limits existed.

## Setting limits

In the dashboard, click the tune icon on a key's row. Or call the keys API
(dashboard login required):

```bash
curl -X PUT http://localhost:20128/api/keys/<id> \
  -H 'Content-Type: application/json' \
  -d '{"budgetUsd": 2000, "allowedModels": ["claude-opus-5-5"], "expiresAt": "2027-01-01T00:00:00Z"}'
```

- `budgetUsd`: a number of dollars, 0 or more. `null` removes the budget. A
  budget of 0 refuses everything.
- `allowedModels`: an array of model ids, aliases or combo names. `null` or `[]`
  allows every model.
- `expiresAt`: any date `Date` can parse, stored as ISO 8601. `null` removes it.
- `resetSpend: true`: starts the key back at $0 against its budget.

Invalid values get a `400` with the reason, and nothing is saved.

**Top up** a key by raising its budget. **Reset spend** records the key's
current lifetime spend as a baseline (`spendOffsetUsd`, `spendResetAt`) and
counts against the budget only what it spends after that. Usage history is
never deleted, so the spend view and the usage page still show everything the
key ever spent.

## How spend is counted

Spend is the `cost` 10router already records for each request in
`usageHistory`, from the pricing table (Dashboard → Pricing), the same number
the usage page shows. Each key keeps a running total (`apiKeys.spentUsd`,
`requestCount`, `lastUsedAt`) that is updated in the same transaction as the
usage row, so the request path reads one row and never sums history. Migration
005 seeds the totals from existing history, and a restore from backup rebuilds
them. A backup carries the totals, so a key restored onto another install
(without its history) keeps what it spent.

`spent = spentUsd - spendOffsetUsd`. A request is refused when
`spent >= budgetUsd`.

### Caveats

- **Overshoot.** The check runs before a request starts; its cost is known
  only when it ends. Requests already in flight when the key reaches its budget
  finish and are charged, so a key can end up over its budget by what those
  requests cost. There is no reservation of budget for in-flight requests.
  For example: a $2,000 key has spent $1,999. Claude Code starts 8 subagents at
  once, each a long Opus request that ends up costing about $5. All 8 pass the
  check (spent $1,999 < $2,000), so the key finishes at about $2,039, and only
  the next request gets the 402. The overshoot is bounded by how many requests
  run at once times what each costs.
- **Streams cut short: a time floor.** When a stream ends before the
  provider's final usage (the client hangs up or presses Esc, the upstream
  stalls or drops), the upstream is dropped about half a second later and the
  request is charged an estimate whose output is the largest of: the output
  the provider reported so far (not Anthropic's `output_tokens: 1`
  placeholder), what visibly streamed, and **150 output tokens per second**
  the stream ran: from the upstream's first byte (so the wait before the first
  byte, prefill, isn't billed; executors that read ahead, like Codex's, start
  when their response arrived) to the cut. When the stall watchdog ends a
  stream, the floor stops at the last byte the upstream sent, so the silent
  window isn't billed as generation. The floor
  exists because thinking can be hidden (`display: "omitted"`), and a model
  thinking for 30 seconds streams nothing visible: without it, an early Esc
  would make a long generation nearly free. The floor never goes above the
  output cap sent upstream (`max_tokens`, `max_output_tokens`,
  `max_completion_tokens`, Gemini's `maxOutputTokens`), which a translator may
  set higher than the client asked (Claude raises it for tools or a thinking
  budget), and never below what the provider reported or visibly streamed.
  Completed streams are charged exactly what the provider reports, however
  long they ran. Set `STREAM_ABORT_FLOOR_TPS` to change the rate (`0` turns
  the floor off). This applies to every key, so the usage page counts cut-short
  requests the same way.
- **Non-streaming requests cut short.** A client that hangs up on a
  non-streaming request after it went upstream is charged the same kind of
  estimate: its input, plus the time floor from when the request was sent
  (a JSON upstream generates its whole answer before it replies), or, when the
  upstream was answering as a stream (a provider set to always stream), from
  its first byte. A stream cut before its first byte pays for its input only.
  These are recorded as errors.
- **Opt-in: drain to the real usage.** With `STREAM_DRAIN_MAX_MS` set (it is
  `0`, off, by default), a key with a budget whose client hangs up keeps the
  upstream running: 10router closes the client's stream at once but reads the
  upstream (discarding it) until the final usage arrives, then charges exactly
  that. It ends at `STREAM_DRAIN_MAX_MS` or the stall timeout, and then charges
  the floor estimate above. It is off by default because every Esc would then
  run the whole generation upstream (the owner's quota and rate limits, and up
  to that long of an open connection), which costs too much under load.
- **The estimate, when there is no real usage.** Input is what the provider
  reported (Anthropic sends it at the start), else an estimate from the request
  body: about 4 characters per token for ASCII, one token per non-ASCII
  character (CJK, emoji), and a flat 1,600 tokens per base64 image or file
  rather than its text; other inline files (PDF, audio, text) are estimated
  from their decoded size. Output is described above: what the provider
  reported, what streamed (text, thinking and tool-call arguments, weighed the
  same way), and the time floor. A stream cut off before anything came back
  still pays for its input. A cut-short request is recorded as an error, not a
  success. Context from an earlier turn that the provider keeps
  (`previous_response_id`) isn't in the request body, so it can't be estimated
  when an upstream sends no usage. The usage 10router shows the client when an
  upstream reports none (the estimated `completion_tokens` in the final chunk)
  weighs text the same way, so CJK and emoji now count about one token per
  character there too.
- **Upstreams that send no usage.** A non-streaming request that 10router
  fetches as a stream (a provider or endpoint set to always stream) and whose
  stream reports no usage is charged the same estimate, instead of nothing. On
  the official OpenAI provider, streams ask for the usage chunk
  (`stream_options.include_usage`), so they report it.
- **Fast mode and priority tiers are dropped.** The budget counts standard
  prices, and fast mode (`speed: "fast"`) or a priority/flex tier
  (`service_tier`) bill a multiple the pricing table doesn't have, so a key
  with a budget sends its requests without those two fields.
- **Only priced requests cost anything.** A request whose model has no price
  in the pricing table, and endpoints that don't record usage (images, speech,
  transcription, web search and fetch, video), cost $0 against the budget. They
  are still refused once the budget is used up, and still bound by the
  allowlist and expiry.
- **Require API key.** With "Require API key" off, a client can send no key at
  all and skip every limit. Turn it on for keys you hand out. A key that is
  sent is always checked, in any of the places clients put it:
  `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`.
- **Claude's built-in web search.** When a Claude client uses the built-in
  `web_search` tool on a provider without native search, 10router answers it
  with a side call to `/v1/search` using the same key. With an allowlist, add
  the search provider (for example `tavily`) to the list, or that side call is
  refused and the search goes to the model's provider instead.
- **Rate-limit hold.** A request held open while its provider's limit resets
  is checked again before each retry, so a key that runs out of budget or
  expires during the wait gets its error instead of the retry.

## Model allowlist matching

A requested model is allowed when:

- it is on the list (case and a trailing context window like `[1m]` are
  ignored);
- a bare id on the list (`claude-opus-5-5`) matches that model from any
  provider (`cc/claude-opus-5-5`). A provider-prefixed entry (`cc/claude-opus-5-5`)
  matches only that provider, and not the bare id, which can route to any
  provider;
- it is a model alias whose target is allowed;
- it is a combo whose every member is allowed (for a fusion combo, its judge
  too), or a combo named on the list.

Provider aliases count as the provider (`cc/x` and `claude/x` are the same
entry). A bare id matches one level only: `claude-opus-5-5` allows
`cc/claude-opus-5-5`, but `cc/x` on the list does not allow `openrouter/cc/x`.
The capacity adapter (Settings → Capacity adapter) never routes an allowlisted
key to a model outside its list.

`GET /v1/models`, `GET /v1/models/{kind}`, the Codex catalog
(`/backend-api/codex/models`) and the Gemini list (`/v1beta/models`), called
with an allowlisted key, list only the models it may use, and
`GET /v1/models/{id}` answers 404 for the rest. Video jobs sent as multipart
have no readable model, so an allowlisted key can't create them. Polling an
existing video job checks only expiry.

## Error bodies

On `/v1/messages` (Anthropic format):

```json
{"type":"error","error":{"type":"billing_error","message":"This API key's budget is used up: it has spent $2000.13 of its $2000.00 budget. Ask its owner to raise the budget or reset its spend."}}
```

Everywhere else (OpenAI format):

```json
{"error":{"message":"This API key's budget is used up: …","type":"insufficient_quota","code":"key_budget_exceeded"}}
```

| Limit | Status | OpenAI `type` / `code` | Anthropic `type` |
|---|---|---|---|
| Budget | 402 | `insufficient_quota` / `key_budget_exceeded` | `billing_error` |
| Model | 403 | `permission_error` / `model_not_allowed` | `permission_error` |
| Expiry | 401 | `authentication_error` / `key_expired` | `authentication_error` |

402 rather than 429: a used-up budget doesn't clear by waiting, and the OpenAI
and Anthropic SDKs retry 429s on their own. OpenRouter answers 402 for spent
credit, and Anthropic's API uses 402 for `billing_error`.

## Checking your own key: `GET /v1/key`

The person holding a key can see its own limits and spend, like OpenRouter's
`GET /api/v1/key`. It answers only about the key on the request.

```bash
curl http://localhost:20128/v1/key -H "Authorization: Bearer $KEY"
```

```json
{
  "data": {
    "name": "Opus key",
    "label": "sk-abc12***",
    "is_active": true,
    "limit": 2000,
    "usage": 412.37,
    "limit_remaining": 1587.63,
    "budget_exhausted": false,
    "lifetime_usage": 412.37,
    "usage_reset_at": null,
    "requests": 1840,
    "last_used_at": "2026-11-07T10:12:03.000Z",
    "allowed_models": ["claude-opus-5-5"],
    "expires_at": "2027-01-01T00:00:00.000Z",
    "expired": false,
    "created_at": "2026-11-01T09:00:00.000Z"
  }
}
```

`limit`, `limit_remaining` are `null` for a key with no budget. `x-api-key`
works in place of `Authorization: Bearer`.

## Dashboard

Each key row shows spent / budget / remaining with a progress bar (amber from
80%, red when used up), its request count, when it was last used, and badges
for a model allowlist or expiry. The spend icon opens spend per day for the
last 30 days, spend by model, and the latest requests.

The dashboard's own test calls through `/v1` (model tests, endpoint tests) use
an active key without limits when there is one, so they don't spend someone's
budget or get refused by their allowlist.
