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
- Translators self-register as an import side effect, so a new translator file runs only once it is imported in `open-sse/translator/index.js`.
- Take role, block, and model strings from the constants in `open-sse/translator/schema/` and `open-sse/config/`.
- Binary upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) are decoded inside their own executor, outside the translator.

### Provider registry (`open-sse/providers/registry/`)
One file per provider, starting from `open-sse/providers/REGISTRY_TEMPLATE.js`, with models in `open-sse/config/providerModels.js`. `index.js` is generated: rerun `scripts/generate-registry-index.mjs` after adding a file. Write an executor only for an upstream that is not OpenAI-compatible.

### Persistence
State lives in SQLite under `src/lib/db/` (the old `db.json` is gone). `driver.js` picks an adapter: on Bun, `bun:sqlite` then `sql.js`; on Node, `better-sqlite3` then `node:sqlite` then `sql.js`. `better-sqlite3` is in `optionalDependencies` so installs succeed without build tools.
- Import from `@/lib/db/index.js`. `src/lib/localDb.js` is a compatibility shim. Per-entity logic lives in `src/lib/db/repos/`, migrations in `src/lib/db/migrations/`.
- The DB path comes from `src/lib/db/paths.js`: `DATA_DIR`, else `~/.9router/`. The directory keeps that name for existing installs.
- Usage and logs (`src/lib/usageDb.js`) always write to `~/.9router` and ignore `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in place. They are **fail-open**: on any error, return null and leave the body untouched. They leave `is_error` / `status:"error"` results intact so error traces survive.

### Security
- `custom-server.js` derives the client IP from the TCP socket and honours `X-Forwarded-For` only from a loopback proxy. Keep that guarantee in any request, IP, or rate-limit change.
- A fresh install has no default password. It prints a one-time setup token to the console (`src/lib/auth/setupState.js`, `setupToken.js`), or takes `INITIAL_PASSWORD` (8+ chars) for headless bootstrap. The env contract lives in `.env.example`.

## Commits

Conventional Commits (`fix(translator): …`). Log user-facing changes in `CHANGELOG.md`; bump root and `cli/` versions independently.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
