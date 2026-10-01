# T3 Code usage hub

In 10router, open **Settings > T3 usage hub** and enable **Share subscription
quotas with T3 Code**. Copy the newly generated management key. In T3 Code,
open **Usage providers > Add hub**, enter your 10router base URL and that key.
The URL must be reachable from the T3 server, not just from your browser.

The integration supports Codex and Claude OAuth/access-token connections.
It lists subscription quota windows and Codex reset credits. It does not
configure model routing. T3 can redeem a Codex reset credit through the hub;
this spends a real credit when connected to a real account.

The hub is disabled by default. Disabling it immediately returns HTTP 404 on
all management endpoints. Keys are independent of inference API keys. Only a
SHA-256 hash is stored; a generated key is shown once. Replacing the key
invalidates the old key immediately. Dashboard settings never return its hash.

## Protocol

All endpoints require `Authorization: Bearer <management key>`:

- `GET /v0/management/auth-files`: account metadata with stable `id` and
  `auth_index`, provider, email, disabled flag and selected Codex account claims.
  No access tokens, refresh tokens or raw ID tokens are returned.
- `POST /v0/management/api-call`: CLIProxyAPI request and response envelopes.
  Only exact provider quota and Codex credit URLs/methods are allowed. Caller
  headers are ignored; 10router constructs authorization from the selected
  account, refreshes OAuth credentials when needed and rejects redirects.
- `POST /v0/management/reset-quota`: clears the selected Codex account's local
  model locks and cooldown after a successful credit redemption through this
  process within the preceding minute. It never resets the upstream quota itself.

This implements the subset used by T3, not the full CLIProxyAPI management API.
Credit-redemption confirmation is transient; a server restart between redemption
and cooldown clearing leaves the cooldown in place until its normal expiry.

## Fake subscriptions

Set `TENROUTER_HUB_DEMO=true` on an isolated instance with its own `DATA_DIR`,
then enable the hub in Settings. The hub supplies three fake Codex accounts
and one fake Claude account, all using `example.test` emails. It never queries
real providers or lists real stored connections in this mode. Fake accounts
are not written to provider storage and cannot route inference.

The exhausted Codex account has one simulated reset credit. Redeeming it
changes its quota to zero usage, removes the credit, and supports idempotent
retries. Restart the demo server to restore initial quota/credit fixtures.
