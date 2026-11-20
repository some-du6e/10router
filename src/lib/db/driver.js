import { ensureDirs, restrictDbFilePermissions, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, initError: null, initFailedAt: 0, logged: false };
const state = global._dbAdapter;

async function tryBunSqlite() {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite() {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");
  restrictDbFilePermissions();

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  try {
    await runMigrationOnce(adapter);
  } catch (error) {
    try { adapter.close(); } catch (closeError) {
      console.warn(`[DB] closing the adapter after a failed init failed: ${closeError.message}`);
    }
    throw error;
  }
  return adapter;
}

// A failed init is not retried on every DB call: each attempt re-reads the
// legacy JSON and re-runs the import. Callers get the same error until the
// backoff passes or retryAdapterInit() is called.
export const INIT_RETRY_BACKOFF_MS = 30 * 1000;

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (state.initPromise) return state.initPromise;
  if (state.initError && Date.now() - state.initFailedAt < INIT_RETRY_BACKOFF_MS) throw state.initError;
  state.initPromise = initAdapter().then((a) => {
    state.instance = a;
    state.initError = null;
    return a;
  }, (error) => {
    state.initPromise = null;
    state.initError = error;
    state.initFailedAt = Date.now();
    throw error;
  });
  return state.initPromise;
}

/** Try a failed init again now, without waiting out the backoff. */
export function retryAdapterInit() {
  state.initError = null;
  return getAdapter();
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
