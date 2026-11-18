# AGENTS.md

10router (`10router-app`) is a local AI routing gateway with a Next.js dashboard. One OpenAI-compatible endpoint (`/v1/*`) routes traffic across 40+ upstream providers, with format translation, combo and multi-account fallback, OAuth/API-key credentials, token refresh, quota tracking, and optional cloud sync.

The repo ships two independently versioned packages:
- **Gateway + dashboard** (root `package.json`): `src/` is the Next.js app and its API routes; `open-sse/` is the provider-agnostic routing and translation engine.
- **CLI launcher** (`cli/`, published to npm as `10router`): installs and starts the server and runs the tray. It has its own `package.json` and build.

Read before working in these areas:
- `docs/ARCHITECTURE.md`: request lifecycle, fallback, OAuth refresh, cloud sync, data model. Its persistence section is stale; see [Persistence](#persistence).
- `open-sse/AGENTS.md`: engine conventions and how to add a provider, executor, or translator. Read it before editing anything under `open-sse/`.

## TypeScript migration

The codebase is moving from JavaScript to TypeScript one file at a time:
- Write new code in `src/` and `open-sse/` as `.ts`, or `.tsx` when it renders JSX.
- When a change substantially rewrites an existing `.js` module, convert that module in the same change, provided the conversion stays contained to it.
- Keep import specifiers ending in `.js`. Bundler resolution maps `./foo.js` to `./foo.ts`, so converting a file changes none of its importers.
- Finish with `bun run typecheck` green. Converted files are checked under `strict`; untouched JavaScript is unchecked (`checkJs: false`).
- Everything outside `src/` and `open-sse/` stays JavaScript: `cli/`, `tests/`, `scripts/`, `gitbook/`, and root config files. `custom-server.js` and `cli/` are CommonJS that ships uncompiled, so converting them would break publishing.
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
`src/app/api/v1/*` (via the `/v1/*` rewrite in `next.config.mjs`) → `src/sse/handlers/chat.js` (combo expansion, account-selection loop) → `open-sse/handlers/chatCore.js` (detect format, translate, dispatch, retry/refresh, stream) → `open-sse/executors/*` (`default.js` covers any OpenAI-compatible upstream) → SSE back to the client.

`src/sse/` is the app-side glue and `open-sse/` is the engine. The boundary leaks: `chatCore.js` imports `@/lib/usageDb.js`. Put types shared across it somewhere both sides can import.

### Translators (`open-sse/translator/`)
- Translation pivots through OpenAI format. A translator registered on an exact pair (e.g. `claude:kiro`) is a **direct route** that skips the lossy double hop; use one for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators self-register as an import side effect, so a new translator file runs only once it is imported in `open-sse/translator/index.ts`.
- Take role, block, and model strings from the constants in `open-sse/translator/schema/` and `open-sse/config/`.
- Binary upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) are decoded inside their own executor, outside the translator.

### Provider registry (`open-sse/providers/registry/`)
One file per provider, starting from `open-sse/providers/REGISTRY_TEMPLATE.js`, with models in `open-sse/config/providerModels.js`. `index.js` is generated: rerun `scripts/generate-registry-index.mjs` after adding a file. Write an executor only for an upstream that is not OpenAI-compatible.

### Persistence
State lives in SQLite under `src/lib/db/` (the old `db.json` is gone). `driver.js` picks an adapter: on Bun, `bun:sqlite` then `sql.js`; on Node, `better-sqlite3` then `node:sqlite` then `sql.js`. `better-sqlite3` is in `optionalDependencies` so installs succeed without build tools.
- Import from `@/lib/db/index.js`. `src/lib/localDb.js` is a compatibility shim. Per-entity logic lives in `src/lib/db/repos/`, migrations in `src/lib/db/migrations/`.
- The DB path comes from `src/lib/db/paths.js`: `DATA_DIR`, else `~/.9router/`. The directory keeps that name for existing installs.
- Usage and logs (`src/lib/usageDb.js`) always write to `~/.9router` and ignore `DATA_DIR`.

### Icons
The dashboard draws Material Symbols from a subset font, `src/app/fonts/material-symbols-outlined.woff2`, holding only the icons the source names (listed in the `.icons.txt` beside it). An icon outside the subset renders as its raw name, so after using a new icon name, rerun `node scripts/subset-icon-font.mjs` (needs python3 with `fonttools` and `brotli`) and commit both files; `tests/unit/icon-font-subset.test.js` goes red until you do. The font loads through `next/font/local` in `src/app/layout.js`. Importing `material-symbols/*.css` would pull the full 3.9 MB font back in. The logo is an inline SVG (`src/shared/components/LogoMark.tsx`) so it paints before the font arrives; use it rather than a `hub` icon for the brand mark.

### Security
- `custom-server.js` decides who a request comes from, through two helpers every caller uses: `isOnThisMachine` (a loopback socket with no forwarding header and `TRUST_PROXY` not `true`; `Host` can only rule a request out, since the client picks it) and `clientKeysFor` (the socket for a direct peer; behind a loopback proxy or a peer `TRUST_PROXY` lists as IPs/CIDRs, the rightmost `X-Forwarded-For` entry that is a non-loopback IP and the `X-Real-IP`, both when both are sent, `CF-Connecting-IP` only when neither is; `unknown` behind `TRUST_PROXY=true`). It stamps the result as `x-9r-real-ip` / `x-9r-alt-ips` / `x-9r-via-proxy`, plus `x-9r-via-tunnel` for a loopback peer whose `Host` is `*.trycloudflare.com` or `*.ts.net`, with the peer token, and `src/` reads only those stamps. Keep that guarantee in any request, IP, or rate-limit change: a same-host reverse proxy is remote, and a forwarding header counts only from a loopback or listed peer.
- A fresh install has no default password. It prints a one-time setup token to the console (`src/lib/auth/setupState.js`, `setupToken.js`), or takes `INITIAL_PASSWORD` (8+ chars) for headless bootstrap. The env contract lives in `.env.example`.

Auth rules and the tests that hold them (all run in the default suite, and on PRs in `.github/workflows/security-sso-oauth.yml`, or `security-network-trust.yml` for the network-trust rows):

| Rule | Enforcement |
| --- | --- |
| Network trust: only `isOnThisMachine` grants keyless `/v1`, the local-only routes and private endpoint URLs; the login limiter keys on `clientKeysFor`. `isLoopbackHost` in `custom-server.js` and `isLoopbackHostname` in `dashboardGuard.js` are one rule in two files (`custom-server.js` ships standalone and can't import `src/`). | `custom-server.js`, `isLocalRequest`; `tests/unit/security-network-trust.test.js` (through the real wrapper, both proxy header styles, loopback addresses from headers), `custom-server-peer-headers.test.js`, `codex-ws-bridge-peer.test.js`, the parity table in `dashboard-guard.test.js`. |
| Password login lockout (`login/route.js`): `reserveAttempt` before the password check and `releaseAttempt` exactly once after it, on every key the login has (`getClientKeys`: one, or two when a proxy sent both `X-Forwarded-For` and `X-Real-IP`; refused while any is locked); per key only (IPv4 address, IPv6 /64), no global block. Password logins from this machine share the `local` key, which no header value can produce; the shared `unknown` key locks for a fixed 15 s and never escalates. The setup and SAML ACS routes still use one key with `checkLock`/`recordFail`. | `src/lib/auth/loginLimiter.ts`, `login/route.js`; `security-network-trust.test.js`, `login-route-limiter.test.js`. |
| Browser requests: no Origin and `Sec-Fetch-Site` cross-site or same-site is never local; an `Origin` that isn't this server (`Sec-Fetch-Site: same-origin` first; then same host as `Host` or a Host-rewriting proxy's `X-Forwarded-Host`, same port unless `Host` has none) gets nothing from a session cookie or `requireLogin=false`. With login off, the API answers only loopback names, IP literals and the configured tunnel, `BASE_URL` and `ALLOWED_HOSTS` hosts; a local-only GET without the CLI token needs same-origin proof. With tunnel dashboard access off, the tunnel host and anything stamped `x-9r-via-tunnel` get 403 on every non-public `/api/*` (`isTunnelHost`, also used by password login). | `dashboardGuard.js`; `dashboard-guard.test.js`, `login-route-limiter.test.js`. |
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
