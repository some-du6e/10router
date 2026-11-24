# AGENTS.md

10router (`10router-app`) is a local AI routing gateway with a Next.js dashboard. One OpenAI-compatible endpoint (`/v1/*`) routes traffic across 40+ upstream providers, with format translation, combo and multi-account fallback, OAuth/API-key credentials, token refresh, quota tracking, and optional cloud sync.

The repo ships two independently versioned packages:
- **Gateway + dashboard** (root `package.json`): `src/` is the Next.js app and its API routes; `open-sse/` is the provider-agnostic routing and translation engine.
- **CLI launcher** (`cli/`, published to npm as `10router`): installs and starts the server and runs the tray. It has its own `package.json` and build.

`gateway/` is a Go module (Go 1.24; one dependency, `modernc.org/sqlite`) built into the Docker image. With `GATEWAY_MODE=proxy` it takes the public port and relays to the Node server on loopback; off by default. See `docs/GO_GATEWAY.md`. `.github/workflows/gateway.yml` runs its `gofmt`, `go vet` and `go test -race`. `gateway/internal/db` reads and writes Node's SQLite file and must write the rows Node's repos write; `.github/workflows/gateway-db.yml` holds it to this branch's Node.

Read before working in these areas:
- `docs/ARCHITECTURE.md`: request lifecycle, fallback, OAuth refresh, cloud sync, data model. Its persistence section is stale; see [Persistence](#persistence).
- `open-sse/AGENTS.md`: engine conventions and how to add a provider, executor, or translator. Read it before editing anything under `open-sse/`.
- `cli/AGENTS.md`: launcher rules (which processes it may stop, restarts, the DATA_DIR lock, autostart arguments). Read it before editing `cli/cli.js` or `cli/src/cli/`.

## TypeScript migration

The codebase is moving from JavaScript to TypeScript one file at a time:
- Write new code in `src/` and `open-sse/` as `.ts`, or `.tsx` when it renders JSX.
- When a change substantially rewrites an existing `.js` module, convert that module in the same change, provided the conversion stays contained to it.
- Keep import specifiers ending in `.js`. Bundler resolution maps `./foo.js` to `./foo.ts`, so converting a file changes none of its importers.
- Plain-node entry points, such as the `.github/e2e/*/seed.mjs` seeds, `scripts/seed-demo.mjs` and `npm run dev:demo`, get that `.js`→`.ts` mapping and the `@/` alias only through `node --experimental-loader=./scripts/resolve-src-alias.mjs`. Node strips the types itself, which needs Node 22.18+.
- Finish with `bun run typecheck` green. Converted files are checked under `strict`; untouched JavaScript is unchecked (`checkJs: false`).
- Everything outside `src/` and `open-sse/` stays JavaScript (except the Go `gateway/`): `cli/`, `tests/`, `scripts/`, `gitbook/`, and root config files. `custom-server.js` and `cli/` are CommonJS that ships uncompiled, so converting them would break publishing.
- `scripts/generate-registry-index.mjs` only lists `.js` files in `open-sse/providers/registry/`. Update its filter before converting a registry entry, or the provider silently disappears.

## Installing and running

Install with `bun install` in each worktree, keeping that worktree's own `node_modules`. The repo tracks no lockfiles, deliberately: install without committing a generated `bun.lock` and without changing dependency versions. Where a package does carry a lockfile, install with `bun install --frozen-lockfile`, or `npm ci` for a `package-lock.json`, and fix the cause of any frozen-install failure while leaving the lock as it is.

Bun is the installer; Node stays the runtime. Run the scripts in `package.json` through `npm run` (the `*:bun` variants run on Bun). The deployed port is **20128** (`/dashboard`, `/v1`). The scripts default to 20127, so pass `PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128` to match production. Start from `cp .env.example .env`. Lint with `npx eslint .`.

## Tests

`tests/` is a separate ESM package with vitest. Install root deps first, then `cd tests && bun install`, then `npx vitest run [file]` with paths relative to `tests/`. Ignore the `test` script in `tests/package.json`; it hardcodes `/tmp/node_modules`.

The suite is **red on a clean checkout** (dozens of expected failures), so a raw run proves nothing. Judge a change with `node tests/__baseline__/verify-no-regression.mjs`. Expected failures:
- the tests listed in `tests/__baseline__/known-fails.txt`
- `unit/embeddings.cloud.test.js`, which needs a `cloud/` worker directory that is not in this repo
- `unit/xai-oauth-service.test.js`, which times out without network access to xAI
- `*.real.test.js`, which make live provider calls and need credentials

After touching the provider registry, aliases, or OAuth URLs, also run the matching `tests/__baseline__/verify-*.mjs` snapshot check.

## Architecture gotchas

### Request flow
`src/app/api/v1/*` (via the `/v1/*` rewrite in `next.config.mjs`) → `src/sse/handlers/chat.ts` (combo expansion, account-selection loop) → `open-sse/handlers/chatCore.js` (detect format, translate, dispatch, retry/refresh, stream) → `open-sse/executors/*` (`default.js` covers any OpenAI-compatible upstream) → SSE back to the client.

`src/sse/` is the app-side glue and `open-sse/` is the engine. The boundary leaks: `chatCore.js` imports `@/lib/usageDb.js`. Put types shared across it somewhere both sides can import.

- Gateway handlers read JSON with `readJsonObject` and check `model` with `missingModel` (both in `src/sse/utils/requestBody.js`); tests in `tests/unit/gateway-request-validation.test.js`.

### Translators (`open-sse/translator/`)
- Translation pivots through OpenAI format. A translator registered on an exact pair (e.g. `claude:kiro`) is a **direct route** that skips the lossy double hop; use one for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators self-register as an import side effect, so a new translator file runs only once it is imported in `open-sse/translator/index.ts`.
- Take role, block, and model strings from the constants in `open-sse/translator/schema/` and `open-sse/config/`.
- Binary upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) are decoded inside their own executor, outside the translator.

### Provider registry (`open-sse/providers/registry/`)
One file per provider, starting from `open-sse/providers/REGISTRY_TEMPLATE.js`, with models in `open-sse/config/providerModels.js`. `index.js` is generated: rerun `scripts/generate-registry-index.mjs` after adding a file. Write an executor only for an upstream that is not OpenAI-compatible.

### Persistence
State lives in SQLite under `src/lib/db/` (the old `db.json` is gone). `driver.js` picks an adapter: on Bun, `bun:sqlite` then `sql.js`; on Node, `better-sqlite3` then `node:sqlite` then `sql.js`. With `GATEWAY_MODE=native` it never falls back to `sql.js`, which would overwrite the Go gateway's writes. `better-sqlite3` is in `optionalDependencies` so installs succeed without build tools.
- Import from `@/lib/db/index.js`. `src/lib/localDb.js` is a compatibility shim. Per-entity logic lives in `src/lib/db/repos/`, migrations in `src/lib/db/migrations/`.
- The DB path comes from `src/lib/db/paths.js`: `DATA_DIR`, else `~/.9router/`. The directory keeps that name for existing installs.
- Before changing init, legacy import, backups, adapters or pending counts, read [`src/lib/db/AGENTS.md`](src/lib/db/AGENTS.md): its rules and the test guarding each.
- Usage (`src/lib/usageDb.js`, now a shim over `src/lib/db/repos/usageRepo.js`) lives in the same SQLite file as everything else, so it follows `DATA_DIR` too.
- A token refresh result's `providerSpecificData` holds only the fields the refresh changed. Save the whole result with `updateProviderCredentials` (`src/sse/services/credentialSave.js`, re-exported by `tokenRefresh.js`), or `saveRefreshedCredentials` where the caller goes on with the new tokens even if the save fails; the connection test passes its `refreshTokenUsed` through it. `updateProviderConnection` then applies that metadata over the stored row and stamps `lastRefreshAt` (only if the access token changed) in one transaction. On the request's own copy, the chat, embeddings, image and video cores, the Kiro model lister and the translator's send apply it with `applyRefreshedCredentials`; usage polling merges `buildCredentialUpdates` the same way. `tests/unit/gateway-refresh-persistence.test.js`, `refresh-metadata-patch.test.js` and `refresh-retry-credentials.test.js` hold this.

### Icons
The dashboard draws Material Symbols from a subset font, `src/app/fonts/material-symbols-outlined.woff2`, holding only the icons the source names (listed in the `.icons.txt` beside it). An icon outside the subset renders as its raw name, so after using a new icon name, rerun `node scripts/subset-icon-font.mjs` (needs python3 with `fonttools` and `brotli`) and commit both files; `tests/unit/icon-font-subset.test.js` goes red until you do. The font loads through `next/font/local` in `src/app/layout.js`. Importing `material-symbols/*.css` would pull the full 3.9 MB font back in. The logo is an inline SVG (`src/shared/components/LogoMark.tsx`) so it paints before the font arrives; use it rather than a `hub` icon for the brand mark.

### Dashboard

These run in the default suite, and on PRs in `.github/workflows/dashboard-saves.yml`.

| Rule | Enforcement |
| --- | --- |
| A failed dashboard write must reach the user. The pricing, combo, proxy-settings and reauth writes go through `src/shared/utils/api.js`, which throws on any non-2xx response (with `status` and the server's message), so the failure reaches the caller. The caller shows the error, releases its pending state, keeps the dialog open, and keeps the saved value until the API accepts the new one. Pricing, proxy settings, combo strategies and the capacity adapter can be saved only after their settings have loaded (a positive `loaded` flag, not the absence of an error), and the page says why when they didn't, so nothing is written over values that never loaded. The combos page reads its settings once, on mount, since creating or editing a combo doesn't change them, and runs its settings saves one at a time, each built on the last value the API accepted, so a change made while another is saving isn't lost. Its settings, combos and providers load separately, each with its own error, so a providers failure doesn't lock the settings, and a save never clears a load error. A sign-in clears an account's error only when the auth route's response names that account (`reauthOutcome` in `src/shared/utils/reauthOutcome.js`), so an auth route that saves credentials must return the connection it saved, as `connection.id` or `connectionId`, and its modal must pass that response to `onSuccess`. Otherwise reauth keeps the old error and warns that the selected account wasn't re-authenticated. | `tests/unit/dashboard-api.test.js` (non-2xx errors, header merging), `dashboard-pricing.test.js` (pricing load, save and reset failures), `dashboard-combo-form.test.js` (combo form retry and close-while-saving), `dashboard-save-and-reauth.test.js` (combos page writes; its settings-load guard, which a failed settings read trips and a failed providers load doesn't; a combos load error that survives a save; create and edit reloading only the combos, not the settings; capacity changes made while a save is pending; proxy settings; Cowork's combo create; the provider page's reauth, which clears the error only for the signed-in account, warns for a different one, and stays quiet on a plain add; and the connection id through OAuthModal poll-status, the GitLab PAT route and modal, and the Kiro wrapper and API-key form). They render components with `tests/helpers/dashboardComponent.js`, whose hooks `dashboard-component.test.js` checks. |

### Security
- `custom-server.js` decides who a request comes from, through two helpers every caller uses: `isOnThisMachine` (a loopback socket with no forwarding header and `TRUST_PROXY` not `true`; `Host` can only rule a request out, since the client picks it) and `clientKeysFor` (the socket for a direct peer, and for a peer `TRUST_PROXY` lists as IPs/CIDRs that sent no forwarding header; behind a loopback proxy, or a listed peer that sent one (`isListedProxyHop`), the rightmost `X-Forwarded-For` entry that is a non-loopback IP and the `X-Real-IP`, both when both are sent, `CF-Connecting-IP` only when neither is; `unknown` behind `TRUST_PROXY=true`). It stamps the result as `x-9r-real-ip` / `x-9r-alt-ips` / `x-9r-via-proxy`, `x-9r-proxy-hop` (`loopback` for a loopback peer that isn't local, `listed` for a listed peer that sent a forwarding header; its `Host` may be the proxy's, so the login-off Host check refuses a loopback one behind either, and an IP literal behind a `listed` hop unless `ALLOWED_HOSTS` or `BASE_URL` names it), plus `x-9r-via-tunnel` for a loopback peer whose `Host` is `*.trycloudflare.com` or `*.ts.net`, with the peer token, and `src/` reads only those stamps. Keep that guarantee in any request, IP, or rate-limit change: a same-host reverse proxy is remote, a forwarding header counts only from a loopback or listed peer, and a listed peer without one is a direct peer. Behind the Go gateway (`GATEWAY_MODE=proxy`), the "socket" in all of this is the client connection the gateway hands over in `x-9r-gw-peer-ip` / `-port` with its token; a loopback request carrying those headers without proof is `unknown`, never local. It also stamps the raw TCP peer (or that handed-over one) as `x-9r-socket-ip` / `x-9r-socket-port`, whatever `TRUST_PROXY` says, for the CLI launcher's `/api/health` proof only; nothing may key on or trust them (`tests/unit/launch-proof.test.js`).
- A connection test shares `withCredentialRefreshLock` with the request path's proactive and background refresh (`checkAndRefreshToken`). A request's refresh after a 401 takes it only for Codex and Grok CLI, whose executors go through `refreshProviderCredentials`; for other providers it doesn't. Inside the lock it re-reads the row and uses the stored tokens if a request, another test or a new sign-in rotated them since it read the row, refreshing those once if they are refused. It saves a successful refresh as soon as it returns, before any probe that follows, stamping `lastRefreshAt` so `checkAndRefreshToken` adopts it when the refresh token rotated, and only onto a row that still holds the refresh token it used or the one it got (`updateProviderConnection`'s `refreshTokenUsed`). Every status write it makes on an OAuth row is under the same check. Rotating providers retire the old token whatever the probe says (`tests/unit/oauth-probe-refresh-persistence.test.js`, `tests/unit/connection-refresh-token-cas.test.js`).
- Codex identity comes from `extractCodexAccountInfo(idToken, accessToken)`. The access token fills ID-token gaps only when the ID token is missing, undecodable, or names the same `sub`. When the two name different subjects, the access token's claims win, since it's the stored credential, and `subjectMismatch` is set as a flag only; nothing refuses the pair, because ID and access tokens aren't known to share `sub` (`tests/unit/oauth-codex-identity.test.js`).
- A fresh install has no default password. It prints a one-time setup token to the console (`src/lib/auth/setupState.js`, `setupToken.js`), or takes `INITIAL_PASSWORD` (8+ chars) for headless bootstrap. The env contract lives in `.env.example`.

Auth rules and the tests that hold them (all run in the default suite, and on PRs in `.github/workflows/security-sso-oauth.yml`, or `security-network-trust.yml` for the network-trust rows):

| Rule | Enforcement |
| --- | --- |
| Network trust: only `isOnThisMachine` grants keyless `/v1`, the local-only routes and private endpoint URLs; the login limiter keys on `clientKeysFor`. `isLoopbackHost` in `custom-server.js` and `isLoopbackHostname` in `dashboardGuard.js` are one rule in two files (`custom-server.js` ships standalone and can't import `src/`). The whole client-IP rule also has a Go port in `gateway/internal/clientip`: change both. | `custom-server.js`, `isLocalRequest`; `tests/unit/security-network-trust.test.js` (through the real wrapper, both proxy header styles, loopback addresses from headers), `custom-server-peer-headers.test.js`, `codex-ws-bridge-peer.test.js`, the parity table in `dashboard-guard.test.js`, `gateway-clientip-parity.test.js` with `gateway/internal/clientip/testdata/parity.json` (Go and JS), `gateway-peer-handoff.test.js`. |
| Password login lockout (`login/route.js`): `reserveAttempt` before the password check and `releaseAttempt` exactly once after it, on every key the login has (`getClientKeys`: one, or two when a proxy sent both `X-Forwarded-For` and `X-Real-IP`); per key only (IPv4 address, IPv6 /64), no global block. Two-key failures go in their own table, since one key is the client's to choose: a two-key login is refused by a lock on either key in either table, a one-key login only by one-key locks. Password logins from this machine share the `local` key, which no header value can produce; the shared `unknown` key locks for a fixed 15 s and never escalates. The setup and SAML ACS routes take the same one or two keys (`getClientKeys`) with `checkLock`/`recordFail`. | `src/lib/auth/loginLimiter.ts`, `login/route.js`, `setup/route.js`, `saml/acs/route.js`; `security-network-trust.test.js`, `login-route-limiter.test.js`. |
| Browser requests: no Origin and `Sec-Fetch-Site` cross-site or same-site is never local; an `Origin` that isn't this server (`Sec-Fetch-Site: same-origin` first; then same host as `Host` or a Host-rewriting proxy's `X-Forwarded-Host`, same port unless `Host` has none) gets nothing from a session cookie or `requireLogin=false`. With login off, the API answers only loopback names, IP literals and the configured tunnel, `BASE_URL` and `ALLOWED_HOSTS` hosts, minus a loopback `Host` behind any proxy hop and an IP-literal `Host` behind a listed proxy hop unless `ALLOWED_HOSTS` or `BASE_URL` names it; a local-only GET without the CLI token needs same-origin proof. With tunnel dashboard access off, the tunnel host and anything stamped `x-9r-via-tunnel` get 403 on every non-public `/api/*` (`isTunnelHost`, also used by password login). | `dashboardGuard.js`; `dashboard-guard.test.js`, `login-route-limiter.test.js`. |
| Bind every OIDC ID token to the stored login nonce. Bind every SAML response to the request named in the browser's `saml_state` cookie (HMAC-signed with the session secret, 10-minute expiry) and use each request once per process. `/start` keeps no server state. Missing or bad state fails closed. | `verifyOidcIdToken`, `createSamlStateCookie`/`readSamlStateCookie`, `validateSamlResponse`; `tests/unit/oidc-token-binding.test.js` (real signed tokens and JWKS), `saml-state-cookie.test.js` (tampering, other secret, expiry), `auth-secret.test.js` (one secret file, first-boot race), `saml-response-binding.test.js` (cookieless and replayed responses), `saml-signed-request-binding.test.js` (real signed XML: forged cookie, replay, expiry, /start spam, a second process). |
| The server routes resolve the login mode through `src/lib/auth/authMode.ts` (`getConfiguredSsoType`, `isPasswordLoginDisabled`). Password mode can't enable a saved SSO configuration, "both" keeps the password recovery paths, and Reset Password in SSO-only mode switches to "both" unless `INITIAL_PASSWORD` is set. While setup is pending for any reason, the API takes no password session (`hasValidToken` via `acceptsDashboardSession`, `dashboard-guard.test.js`). With a configured SSO protocol, `/login` and SSO sign-in stay reachable, and the dashboard pages and API take only a session from that protocol, or the CLI token (`dashboardGuard.js`, `loginLanding.ts`). The OIDC/SAML settings test routes are dashboard APIs, not public, and the OIDC test sends the saved client secret only to the saved issuer (`oidc-test-route.test.js`). `authMode.ts` has no dependencies, because the request proxy loads `setupState.js`. | Bootstrap, OIDC runtime, SAML start/ACS, password login, Reset Password and auth status; `tests/unit/auth-mode-consistency.test.js`, `auth-login-mode.test.js`, `dashboard-guard.test.js`, `auth-status.test.js`, `login-landing.test.js`. The profile page still reads the mode itself. |
| HTTPS SAML request-state cookies must survive the IdP's cross-site POST. | `tests/unit/saml-start-cookie.test.js`. |
| `SSO_ALLOWED_USERS` gates OIDC and SAML sign-in, and a refusal doesn't count toward the login lockout. Email entries match only an IdP-verified email; entries without `@` match only the subject. | `tests/unit/sso-allowlist.test.js`. |
| The Trae loopback proxy answers only its random callback path. | `tests/unit/trae-callback-binding.test.js`. |
| The OAuth connect dialog uses a relayed callback only when it echoes the pending login's state; Cline and Cline Pass (no state) only from the popup the dialog opened (a fresh window name per login) and from the redirect URI's origin. Never for proxy providers (Trae, Windsurf, Zed). Anything else, a stateless `?error=` included, is ignored without ending the login, and a pasted URL naming another login's state is refused. | `handleRelayedCallback`, `isOwnPopup`, `newPopupName` and `parsePastedCallback` in `src/shared/utils/oauthCallbackBinding.ts`; `tests/unit/oauth-callback-binding.test.js`. |

## Commits

Conventional Commits (`fix(translator): …`). Log user-facing changes in `CHANGELOG.md`; bump root and `cli/` versions independently.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
