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
- **Streams cut short still cost.** A stream the client closes (or that stalls,
  or whose upstream drops) before its final event is charged for its input and
  for what it streamed. Input is what the provider reported (Anthropic sends it
  at the start), else an estimate from the request. Output is the larger of
  what the provider reported and an estimate from the streamed text, thinking
  and tool-call arguments, since the output count sent at the start of a
  stream is a placeholder. A stream cut off before anything came back still
  pays for its input. Such a request is recorded as an error, not a success.
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
