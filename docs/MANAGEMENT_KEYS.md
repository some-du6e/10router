# Management keys

A management key lets a script or a person manage keys over an API without
dashboard access. Each one has a scope, and it can't do anything outside it. For
example:

- A key that can only add and remove upstream keys for one custom endpoint (say
  Snowflake), so someone can top up the pool and nothing else.
- A key that can create, list and delete client keys, but only keys limited to
  `openai/*` models and capped at a $50 budget each.

Management keys live on the Endpoint page, under API Keys. Create one there,
pick its scope, and copy the secret. It is shown once. 10router stores only its
sha256 hash, so a lost key can't be recovered, only revoked and replaced.

A management key starts with `10r-mgmt-`. Client keys start with `sk-`. The
gateway refuses a `10r-mgmt-` token on every `/v1` route with a `401`, even
from localhost, and the management API accepts nothing else.

## Scopes

```json
{
  "clientKeys": {
    "enabled": true,
    "providers": ["openai"],
    "models": null,
    "maxBudgetUsd": 50,
    "manageExisting": false
  },
  "providerKeys": {
    "enabled": true,
    "providers": ["openai-compatible-chat-snowflake"],
    "manageExisting": false
  }
}
```

### Client keys

With `clientKeys.enabled`, the key can list, create, edit and delete 10router
API keys (the ones on the Endpoint page). The limits it can set are the ones in
[API_KEY_BUDGETS.md](API_KEY_BUDGETS.md): `budgetUsd`, `allowedModels` and
`expiresAt`.

- `providers`: every key it creates or edits must have a non-empty
  `allowedModels`, and every entry must be a `provider/model` id for one of
  these providers. Provider aliases count (`cc/...` is `claude`), and so do
  custom endpoint prefixes, which map to their node id.
- `models`: every entry must match one of these, using the same matching as
  the request path. `cc/claude-opus-5-5` matches a listed `claude-opus-5-5`, and
  a bare id is accepted only when the scope lists that same bare id.
- `maxBudgetUsd`: every key it creates or edits must have a budget, at most
  this much.
- A key it edits is checked as a whole after the change, so it can't widen a
  key it created, or clear its budget.

Under a `providers` or `models` scope, aliases and combo names can't go on a
key's allowlist. A bare name on an allowlist also allows `<any provider>/<name>`
at request time, so it would step outside the scope. Use `provider/model` ids.

The cap is per key. Nothing caps the total across a management key's keys, so a
key allowed to create ten keys at $50 can hand out $500. Spend resets
(`resetSpend`) aren't available through the management API, since a reset is a
fresh budget. Delete and recreate is still possible, so treat the cap as a
per-key limit, not a total.

### Provider keys

With `providerKeys.enabled`, the key can list, add and delete upstream keys
(provider connections). `providers` limits which providers. Use registry ids
(`openai`, `anthropic`, ...) or the id of a custom endpoint, which you can see in
its URL on the Providers page. Without `providers` it can add keys for any
provider that takes an API key.

Adding a key goes through the same code the dashboard uses: the validation
ping (`/api/providers/validate`), then the create route (`/api/providers`). A
key the provider refuses is not added, and the response is a `422`. A name
that's already taken for that provider gets a `409`. It never overwrites an
existing key.

The management API takes `provider`, `apiKey`, `name`, `defaultModel` and a few
`providerSpecificData` fields (`accountId`, `region`, `deployment`,
`organization`, `apiVersion`). It takes no URL or proxy fields (`baseUrl`,
`azureEndpoint`, `connectionProxyUrl`, a proxy pool), since those decide where
10router sends the key. Providers that need one (Azure, Ollama local, a custom
endpoint's per-key URL) have to be set up in the dashboard. Keys for a custom
endpoint use the endpoint's own URL.

### What a key can see

By default a management key sees, edits and deletes only rows it created.
`manageExisting: true` widens that to every row inside its scope, including keys
made in the dashboard. A key with no `providers`, `models` or cap plus
`manageExisting` is an admin for that kind of key.

Either way, a row must still be inside the key's current scope. Narrow a scope
in the dashboard and the key loses sight of rows it made under the old one.
Rows it can't see answer `404`, the same as rows that don't exist.

## API

Base path `/api/management/v1`. Send the key as `Authorization: Bearer
10r-mgmt-...`. A dashboard session cookie, the CLI token, and "Require login"
being off don't count here.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/me` | This key's name, scopes, expiry and last use |
| `GET` | `/client-keys` | Client keys it can see |
| `POST` | `/client-keys` | Create one: `{ name, allowedModels?, budgetUsd?, expiresAt? }` |
| `GET` | `/client-keys/:id` | One client key |
| `PATCH` | `/client-keys/:id` | Change `name`, `isActive`, `allowedModels`, `budgetUsd`, `expiresAt` |
| `DELETE` | `/client-keys/:id` | Delete it |
| `GET` | `/provider-keys[?provider=id]` | Provider keys it can see |
| `POST` | `/provider-keys` | Validate and add one: `{ provider, apiKey, name?, defaultModel?, providerSpecificData? }` |
| `GET` | `/provider-keys/:id` | One provider key |
| `DELETE` | `/provider-keys/:id` | Delete it |

```bash
MK=10r-mgmt-...   # from the dashboard

# Hand out a $20 key for GPT-5
curl -X POST http://localhost:20128/api/management/v1/client-keys \
  -H "Authorization: Bearer $MK" -H 'Content-Type: application/json' \
  -d '{"name": "intern", "allowedModels": ["openai/gpt-5"], "budgetUsd": 20}'

# Add an upstream key to the Snowflake pool
curl -X POST http://localhost:20128/api/management/v1/provider-keys \
  -H "Authorization: Bearer $MK" -H 'Content-Type: application/json' \
  -d '{"provider": "openai-compatible-chat-snowflake", "apiKey": "...", "name": "pool 7"}'
```

Unknown body fields get a `400`, so a typo can't silently do nothing. A request
outside the scope gets a `403` with the reason.

### What responses contain

Responses are built field by field. They never include provider secrets
(`apiKey`, `accessToken`, `refreshToken`, `idToken`, `providerSpecificData`), a
management key's secret or hash, or a full client key. The one exception is
`POST /client-keys`, whose response carries the new key once, in `key`. Later
reads show `keyPreview` (the first 8 characters).

A client key row has `id`, `name`, `keyPreview`, `isActive`, `budgetUsd`,
`allowedModels`, `expiresAt`, `spentUsd`, `lifetimeSpentUsd`, `requestCount`,
`lastUsedAt`, `createdAt` and `createdByYou`. A provider key row has `id`,
`provider`, `name`, `authType`, `isActive`, `testStatus`, `priority`,
`createdAt`, `updatedAt` and `createdByYou`.

### Management keys themselves

There is no route for management keys in the management API. Creating, editing,
listing and revoking them happens only in the dashboard
(`/api/management-keys`, behind the login), so a management key can't give
itself or another key more scope.

## Turning keys off

- **Off**: the toggle on its row. It gets `401` until turned back on.
- **Expiry**: set a date and it gets `401` after it.
- **Revoke**: the delete icon. The key stops working at once. Keys it created
  stay, and the dashboard still shows which management key made them.

Each row also shows when the key was last used and which client and provider
keys it created.

## Audit log

Every create, edit and delete through the management API is logged, and so is
every refused one (with the reason). Creating, changing and revoking keys in
the dashboard is logged too. The Endpoint page shows the latest entries. Each
entry has the management key, the action, the target's type and id, a time, and
a detail with names, providers and limits. It never holds a secret. The log
keeps the newest 5000 entries.

## Storage

Migration 006 adds two tables and one column:

- `managementKeys`: `id`, `name`, `keyHash` (sha256 of the secret), `keyPrefix`
  (`10r-mgmt-` plus 6 characters, for display), `scopes` (JSON), `isActive`,
  `expiresAt`, `createdAt`, `lastUsedAt`.
- `managementAudit`: `managementKeyId`, `action`, `targetType`, `targetId`,
  `at`, `detail` (JSON).
- `ownerManagementKeyId` on `apiKeys` and `providerConnections`. `NULL` means the
  dashboard made the row.

Management keys are not in backups (`exportDb`), and a restore clears the owner
column. After a restore, management keys keep working, but a key without
`manageExisting` no longer sees the rows it made before.
