// Opens Node's database layer on a fresh DATA_DIR with a chosen driver, the
// way driver.js would (adapter, migrations, _meta.dbDriver), so a test can run
// the real repos on sql.js, node:sqlite or better-sqlite3 in one process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

export const FACTORIES = {
  "sql.js": async () => (await import("@/lib/db/adapters/sqljsAdapter.js")).createSqlJsAdapter,
  "node:sqlite": async () => (await import("@/lib/db/adapters/nodeSqliteAdapter.js")).createNodeSqliteAdapter,
  "better-sqlite3": async () => (await import("@/lib/db/adapters/betterSqliteAdapter.js")).createBetterSqliteAdapter,
};

/** Can this process load the driver? sql.js always can. */
export async function driverAvailable(driver) {
  if (driver === "sql.js") return true;
  try {
    if (driver === "node:sqlite") {
      const { DatabaseSync } = await import("node:sqlite");
      new DatabaseSync(":memory:").close();
    } else {
      const { default: Database } = await import("better-sqlite3");
      new Database(":memory:").close();
    }
    return true;
  } catch (error) {
    // CI builds both: a missing one fails there instead of skipping.
    if (process.env.REQUIRE_NATIVE_SQLITE === "1") throw error;
    return false;
  }
}

export function tempDataDir(prefix = "node-db-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Close whatever adapter the last openRepos (or driver.js) left open. */
export function closeRepos() {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
}

/**
 * Fresh modules on dataDir with `driver`. `wrap` may replace the adapter the
 * repos see (instrumentation).
 * @returns {Promise<{ repos: any, adapter: any, file: string }>}
 */
export async function openRepos(driver, dataDir, { wrap } = {}) {
  closeRepos();
  process.env.DATA_DIR = dataDir;
  // Caches kept on global outlive vi.resetModules; they belong to the last database.
  delete global._settingsCache;
  delete globalThis.__requestDetailsConfigCache;
  vi.resetModules();
  const { DATA_FILE, ensureDirs } = await import("@/lib/db/paths.js");
  ensureDirs();
  const factory = await FACTORIES[driver]();
  const raw = await factory(DATA_FILE);
  const adapter = wrap ? wrap(raw) : raw;
  // Before anything imports driver.js, which adopts this state object.
  global._dbAdapter = { instance: adapter, initPromise: null, initError: null, initFailedAt: 0, logged: true };
  const { runMigrationOnce } = await import("@/lib/db/migrate.js");
  await runMigrationOnce(adapter);
  const { recordDriver } = await import("@/lib/db/driver.js");
  recordDriver(adapter);
  const repos = await import("@/lib/db/index.js");
  return { repos, adapter, file: DATA_FILE };
}

/** _meta.configGeneration as a number (0 when unset). */
export function generation(adapter) {
  return Number(adapter.get(`SELECT value FROM _meta WHERE key = 'configGeneration'`)?.value ?? 0);
}
