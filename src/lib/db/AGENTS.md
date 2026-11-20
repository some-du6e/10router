# Persistence checks

| Rule | Enforcement |
| --- | --- |
| A legacy JSON import runs only while `_meta.legacyImportPending` is `1` and the tables it writes (`settings`, `providerConnections`, `providerNodes`, `proxyPools`, `apiKeys`, `combos`) are empty. The flag is set on a fresh DB before schema migrations and cleared by a successful import, or once the files are gone or the tables hold data. `SKIP_LEGACY_IMPORT=1` boots without importing. | `tests/unit/db-legacy-import-retry.test.js` covers retry, removed and restored files, the escape, and a non-fresh DB with no flag. |
| A failed init is cached in `driver.js` for `INIT_RETRY_BACKOFF_MS`; `retryAdapterInit()` retries at once. Each backup step goes through `backupOnce` in `backup.js`, which runs it at most once per process and keeps it out of `pruneOldBackups`. | `tests/unit/db-legacy-import-retry.test.js` makes repeated failing calls and counts imports and backup directories. |
| Write `limitHold` in legacy imports with `toLimitHoldColumn` from `repos/apiKeysRepo.js`. | `tests/unit/db-api-key-backup.test.js` |
| sql.js re-runs `PRAGMA_SQL` after every export. | `tests/unit/db-adapter-integrity.test.js` inserts an invalid foreign key after the save debounce. |
| Adapters register shutdown handlers through `helpers/shutdown.ts`, and `close()` removes them, including the close after a failed init. | `tests/unit/db-adapter-integrity.test.js` and `tests/unit/db-legacy-import-retry.test.js` compare process listener counts. |
| The adapter suite always runs sql.js and probes native bindings separately from adapter factories. `REQUIRE_NATIVE_SQLITE=1` makes a missing binding fail; `.github/workflows/db-persistence.yml` sets it after building better-sqlite3. | `tests/unit/db-adapter-integrity.test.js` |
| Pending counts live in one bucket per account and model (`_pendingBuckets`), behind the `{byModel, byAccount}` view. A completion decrements only a bucket it started; an expiring bucket clears only itself. | `tests/unit/db-pending-request-timeouts.test.js`, `tests/unit/chat-core-translation-failure-pending.test.js` |

Run these checks from `tests/` with `./node_modules/.bin/vitest run unit/db-legacy-import-retry.test.js unit/db-api-key-backup.test.js unit/db-adapter-integrity.test.js unit/db-pending-request-timeouts.test.js unit/chat-core-translation-failure-pending.test.js`.
