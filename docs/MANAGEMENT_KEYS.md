# Management keys

A management key lets a script or a person manage keys over an API without
dashboard access. Each one has a scope, and it can't do anything outside it. For
example:

- A key that can only add and remove upstream keys for one custom endpoint, so a
  script can top up the pool and nothing else.
- A key that can create, list and delete client keys, but only keys limited to
  `openai/*` models and capped at a $50 budget each.

Management keys live on the Endpoint page, under API Keys. Create one there,
pick its scope, and copy the secret. It is shown once. 10router stores only its
sha256 hash, so a lost key can't be recovered, only revoked and replaced.

A management key starts with `10r-mgmt-`. Client keys start with `sk-`. The
gateway refuses any token containing `10r-mgmt-` on every inference route
(`/v1`, `/v1beta`, `/codex`, `/responses`, `/systemone`, `/backend-api/codex`)
with a `401`, even from localhost and however it is padded. The management API
accepts nothing else.

`/backend-api/codex` gets the same key check as `/v1`: none from this machine,
a client key from anywhere else. Codex's WebSocket transport follows the same
rule. A client on this machine (a loopback connection with no forwarding
headers) stays local, while a remote client, or one that came through a local
reverse proxy or tunnel, is treated as remote.

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
    "providers": ["openai-compatible-chat-<id>"],
    "manageExisting": false,
    "baseUrlHosts": { "openai-compatible-chat-<id>": ["*.acme.example"] }
  }
}
```

A stored scope that doesn't parse, or has a field of the wrong type, grants
nothing until the dashboard saves it again.

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

The dashboard has the last word on a key's on/off state and expiry. If the
dashboard turned a key off, no management key can turn it back on. If the
dashboard set its expiry, a management key can only move it earlier. A key that
was off, or had an expiry, before this was recorded counts as the dashboard's.
A management key can undo its own choices. Repeating the dashboard's choice
(turning off a key that is already off, or setting the same or an earlier
expiry) doesn't make it the management key's. The dashboard takes over any
on/off state or expiry it changes itself, and saving a key's other limits in
the dashboard leaves its expiry's owner alone.

### Provider keys

With `providerKeys.enabled`, the key can list, add and delete upstream API keys
(provider connections with `authType: "apikey"`). OAuth logins and session
cookies are never reachable, not even with `manageExisting`, and providers that
take a session cookie can't be added. `providers` limits which providers. Use
registry ids (`openai`, `anthropic`, ...) or a custom endpoint's id
(`openai-compatible-chat-<id>`, shown in its URL on the Providers page).
Without `providers` it can add keys for any provider that takes an API key.

Adding a key goes through the same code the dashboard uses: the validation
ping (`/api/providers/validate`), then the create route (`/api/providers`).

- A key the provider refuses is not added, and the response is a `422`.
- A probe that doesn't answer in 15 seconds is given up on with a `504`, and
  nothing is added.
- An error from the validator itself (a custom endpoint that no longer exists,
  a bad field) comes back with its own status.
- The management key is checked again after the probe, so a key revoked or
  narrowed while the probe ran adds nothing.
- `apiKey` can be at most 8192 characters.
- A custom endpoint's probe is built like the request routing would send on
  that key: its URL, headers and body come from the same code, with the
  endpoint's advanced settings (auth header style, client identity, header
  lines, path and query overrides, model renames, body edits). The
  endpoint's proxy, timeout and retries are not used for the probe. An
  Anthropic-compatible endpoint's probe sends a real
  message, so it names a model: the key's `defaultModel` if given (a
  `(level)` suffix dropped), else one listed for the endpoint, preferring
  one the endpoint doesn't route to another API. Give `defaultModel` when
  each key may only use some models.
- The new row is claimed for the management key right after the create,
  only while that key is still on; if it was revoked in between, the row is
  removed and the response is a `401`.
- A name that's already taken for that provider gets a `409`. It never
  overwrites an existing key. The `409` does tell the caller that a key of that
  name exists for a provider in its scope, which is accepted.

The probe is only as strict as the dashboard's. Some providers have no real
check: a keyless self-hosted endpoint passes on any answer, the generic fallback
counts anything but a 401 or 403 as valid, and a few media providers are
accepted without a probe. Those keys are added and fail later, at use.

The management API takes `provider`, `apiKey`, `name`, `defaultModel`, a few
`providerSpecificData` fields (`accountId`, `region`, `deployment`,
`organization`, `apiVersion`), and `baseUrl` on the terms below. URL and proxy
fields decide where 10router sends the key, so the dashboard decides them: the
others (`azureEndpoint`, `connectionProxyUrl`, a proxy pool, any URL inside
`providerSpecificData`) are always refused, and providers that need one (Azure,
Ollama local) have to be set up in the dashboard.

#### A key's own URL

Some upstreams give each key its own host, one account per host
(`https://key-a.acme.example/...`). A custom endpoint's key can carry its own
URL for that (the per-key URL on the endpoint page), and the dashboard can let a
management key set one. `providerKeys.baseUrlHosts` maps a custom endpoint's id
to the hosts its keys may use ("Own URLs for the keys it adds" in the key's
dialog, under Provider keys). Hosts are allowed per endpoint, so a host trusted
for one endpoint's keys can't be used to send another endpoint's keys
somewhere else.

- `api.acme.example` matches that host only.
- `*.acme.example` matches exactly one more label: `key-a.acme.example`, not
  `acme.example` and not `a.b.acme.example`.

The dashboard checks the list when it saves it:

- each id is a custom OpenAI- or Anthropic-compatible endpoint that exists,
  and one of `providers` when the scope lists some (with no `providers`, the
  ids named here are the endpoints that get hosts);
- each pattern is lowercase, has no bare `*`, has a wildcard only as its first
  label with at least two labels after it, and has no IP address, port or
  `localhost`;
- an endpoint has at most 50 patterns, and the list at most 200 endpoints.

Only the dashboard can set them; no management API route takes scopes. Without
hosts for an endpoint (the default) a `baseUrl` for its keys is refused, and
they use the endpoint's own URL. When an endpoint is deleted, the key's dialog
marks it as a deleted endpoint and, when you save, drops it from `providers`
and its hosts from `baseUrlHosts`. If it was the only provider the scope was
limited to, it is kept, since an empty `providers` would mean any provider:
with provider keys on, the dialog asks you to pick another provider; with
them off, the save goes through (an off scope grants nothing, and its
`providers` aren't checked), and turning them back on asks again. Through the
API, a scope that is on and names a deleted endpoint is refused as an unknown
provider.

With hosts listed for the endpoint, `POST /provider-keys` takes a top-level
`baseUrl` (at most 2048 characters; `null` is the same as leaving it out)
when:

- it parses as a URL and uses `https`;
- it has no user name or password, and no port other than 443;
- its host is not an IP address or `localhost`;
- its host matches one of that endpoint's patterns.

The path and query are free; a `#fragment` is dropped. When the endpoint has no
hosts, or the host isn't one of them, the answer is a `403` (and goes into the
audit log). A URL that breaks one of the other rules gets a `400`. Both carry
`field: "baseUrl"` and the reason. The error never quotes the URL, which can
carry a token in its query. The URL is then validated and saved the same way as
one typed into the dashboard: the validation ping runs at that URL, the
private-network checks apply (a host that resolves to a private address is
refused), and it's stored as the key's own URL (`providerSpecificData.baseUrl`
with `ownBaseUrl`), so requests on that key go there and fail over to the next
key as usual. The hosts are checked again after the probe, so taking a host off
the list while a key is being added adds nothing.

Everything the endpoint sends with a key goes to that key's own URL too: its
header lines and custom headers (Advanced settings), both when the key is
checked and every time it is used. Allowing a host lets whoever runs it see
those values, so don't put a secret in them unless you trust every host the
endpoint's list allows. A refused key's audit entry names the host the check
went to (`baseUrlHost`).

### What a key can see

By default a management key sees, edits and deletes only rows it created.
`manageExisting: true` widens that to every row inside its scope, including keys
made in the dashboard. A key with no `providers`, `models` or cap plus
`manageExisting` is an admin for that kind of key.

A provider key stops being a management key's once someone puts a different
secret in it in the dashboard (editing it, or adding a key of the same name
with overwrite): it then reads as the dashboard's, and the management key can
no longer see or delete it.

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
| `POST` | `/provider-keys` | Validate and add one: `{ provider, apiKey, name?, defaultModel?, providerSpecificData?, baseUrl? }` |
| `GET` | `/provider-keys/:id` | One provider key |
| `DELETE` | `/provider-keys/:id` | Delete it |

```bash
MK=10r-mgmt-...   # from the dashboard

# Hand out a $20 key for GPT-5
curl -X POST http://localhost:20128/api/management/v1/client-keys \
  -H "Authorization: Bearer $MK" -H 'Content-Type: application/json' \
  -d '{"name": "intern", "allowedModels": ["openai/gpt-5"], "budgetUsd": 20}'

# Add an upstream key to a custom endpoint's pool
curl -X POST http://localhost:20128/api/management/v1/provider-keys \
  -H "Authorization: Bearer $MK" -H 'Content-Type: application/json' \
  -d '{"provider": "openai-compatible-chat-<id>", "apiKey": "...", "name": "pool 7"}'

# Add a key with its own URL (the scope lists "*.acme.example" for this endpoint)
curl -X POST http://localhost:20128/api/management/v1/provider-keys \
  -H "Authorization: Bearer $MK" -H 'Content-Type: application/json' \
  -d '{"provider": "openai-compatible-chat-<id>", "apiKey": "...", "name": "key-a",
       "baseUrl": "https://key-a.acme.example/api/v1"}'
```

A client key is created in one insert with its limits and owner, so it never
exists without them, and only while the management key is still on. An edit
and the record of who changed the key's on/off state or expiry are written in
one transaction, which checks the management key and the dashboard's choices
again against the row as it is then, so an admin pausing the key mid-request wins. A provider key whose owner can't be recorded is deleted again.

Unknown body fields get a `400`, so a typo can't silently do nothing. A request
outside the scope gets a `403` with the reason.

### What responses contain

Responses are built field by field. They never include provider secrets
(`apiKey`, `accessToken`, `refreshToken`, `idToken`, `providerSpecificData`), a
management key's secret or hash, or a full client key. The one exception is
`POST /client-keys`, whose response carries the new key once, in `key`. Later
reads show `keyPreview`: at most a third of the key and never more than 8
characters, so a short legacy `sk-xxxxxxxx` key shows only `sk-…`.

A client key row has `id`, `name`, `keyPreview`, `isActive`, `budgetUsd`,
`allowedModels`, `expiresAt`, `spentUsd`, `lifetimeSpentUsd`, `requestCount`,
`lastUsedAt`, `createdAt` and `createdByYou`. A provider key row has `id`,
`provider`, `name`, `authType`, `isActive`, `testStatus`, `priority`,
`createdAt`, `updatedAt` and `createdByYou`.

### Management keys themselves

There is no route for management keys in the management API. Creating, editing,
listing and revoking them happens only in the dashboard
(`/api/management-keys`). Those routes check the dashboard session themselves,
on top of the proxy, so a management key can't give itself or another key more
scope.

## Turning keys off

- **Off**: the toggle on its row. It gets `401` until turned back on.
- **Expiry**: set a date and it gets `401` after it.
- **Revoke**: the delete icon. The key stops working at once. By default the
  keys it created stay. Each one keeps the revoked key's id as its owner, its
  row on the Endpoint page says "made by a deleted management key", and the
  Management Keys section lists them under "Made by deleted management keys",
  with a button to delete them later.
- **Revoke and delete everything it created**: the option in the revoke dialog
  (`DELETE /api/management-keys/:id?deleteCreated=1`). The key is deleted
  first, then the client keys and provider keys it made, so a create still in
  flight fails its claim instead of leaving a row behind.

Each row also shows when the key was last used and which client and provider
keys it created.

## Audit log

These go into the log:

- every create, edit and delete a management key makes;
- a create or edit refused for being outside the scope, a provider-key create
  for a provider outside the scope, a `baseUrl` refused because the scope lists
  no hosts for that endpoint or not its host (also when the dashboard narrowed
  the list during the probe), and a provider key the provider refused, each
  with the reason;
- creating, changing and revoking management keys in the dashboard.

These don't: failed authentication (no key, a wrong key, a key that's off,
expired or revoked), `404`s for rows a key can't see, the `409` for a taken
name, a `504` probe timeout, `400`s for malformed requests, and edits that
change nothing.

Each entry has the management key, the action, the target's type and id, a
time, and a detail with names, providers and limits. A provider key added with
its own URL, or refused for its host, records that host (`baseUrlHost`), never
the full URL. It never holds a secret.
Every detail stays under 2 KB. A refusal's detail is compacted, since the
caller picks its content: strings are cut at 300 characters and lists keep
their first 3 entries plus a count. A success keeps its lists in full (the
fields an edit changed, a new key's allowed models) and falls back to counts
only when that would go over 2 KB.

The log is trimmed in separate pools, so no one can push out someone else's
history: each management key keeps its newest 1000 actions (deleting rows it
created counts as one), apart from those its newest 5000 deletes of rows it
didn't create (the `manageExisting` ones, so a loop of renames or of creating
and deleting its own keys can't trim them away) and its newest 200 refusals,
and the dashboard's own changes keep the newest 2000.

A delete is decided inside its own transaction: the management key must still
be on, and the row must still be its own (or reachable with `manageExisting`,
and for a provider key still an API key). An admin pausing the key or taking
the row over between the request's read and the delete wins.
The Endpoint page shows the latest 30 entries and names each entry's key, or
"deleted management key".

## Storage

Migration 006 adds two tables and some columns:

- `managementKeys`: `id`, `name`, `keyHash` (sha256 of the secret, unique),
  `keyPrefix` (`10r-mgmt-` plus 6 characters, for display), `scopes` (JSON),
  `isActive`, `expiresAt`, `createdAt`, `lastUsedAt`.
- `managementAudit`: `managementKeyId`, `action`, `targetType`, `targetId`,
  `at`, `detail` (JSON), `pool` (`ok`, `denied` or `dashboard`).
- `ownerManagementKeyId` on `apiKeys` and `providerConnections`. `NULL` means the
  dashboard made the row.
- `disabledBy` and `expiresAtSetBy` on `apiKeys`: `"dashboard"` or a management
  key id.

Management keys themselves are not in backups (`exportDb`), and a restore
doesn't touch them. A backup carries each row's `ownerManagementKeyId` (and a
client key's `disabledBy` and `expiresAtSetBy`). A restore keeps one only if
that management key exists on the install it is restored onto, and otherwise
clears it, so ownership is never invented. A key that is off, or has an expiry,
with its actor cleared then counts as the dashboard's.
