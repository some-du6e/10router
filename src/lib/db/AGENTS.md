# Persistence checks

| Rule | Enforcement |
| --- | --- |
| Preserve API key hold overrides in backups and legacy imports. Use `rowToKey` and `toLimitHoldColumn` from `repos/apiKeysRepo.js`. | `tests/unit/db-api-key-backup.test.js` tests true, false and inherited overrides through restore and migration. |
| Reject failed legacy imports, retain retry eligibility across schema initialization, and clear rejected initialization promises. | `tests/unit/db-legacy-import-retry.test.js` corrects invalid legacy JSON and verifies recovery and persistence. |
| Keep connection pragmas active after sql.js exports. | `tests/unit/db-adapter-integrity.test.js` inserts an invalid foreign key after the save debounce. |
| Register adapter shutdown handlers through `helpers/shutdown.js` and unregister on close. | `tests/unit/db-adapter-integrity.test.js` compares process listener counts before opening and after closing each available Node adapter. |
| Preserve nested rollback and synchronous transaction return values across adapters. | `tests/unit/db-adapter-integrity.test.js` checks inner rollback, outer commit, and outer rollback against stored rows. |

Run these checks from `tests/` with `npx vitest run unit/db-api-key-backup.test.js unit/db-legacy-import-retry.test.js unit/db-adapter-integrity.test.js`.
