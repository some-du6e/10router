import { getAdapter } from "../driver.js";
import { connectionsVersion, getProviderConnections } from "./connectionsRepo.js";
import { estimateKeyLifespans, LIFESPAN_RECENT_WINDOW_MS } from "../../../shared/utils/keyLifespan.js";

const CACHE_TTL_MS = 60 * 1000;
// Stay well under SQLite's bound-parameter limit (999 on old builds) on
// bulk-imported providers: four per window, plus two.
export const WINDOW_CHUNK = 200;
// Later than any ISO timestamp: a window that is still open.
const OPEN = "9999";

// A dead key's sums, once its window has settled (requests still in flight
// when it died have landed), keyed by connection, window and death time: no new
// rows can fall in it, so a cache miss only re-reads the live keys.
export const CLOSED_SETTLE_MS = 10 * 60 * 1000;
export const CLOSED_CAP = 10000;

if (!global._keyLifespanCache) global._keyLifespanCache = new Map();
const cache = global._keyLifespanCache;
if (!global._keyLifespanClosed) global._keyLifespanClosed = new Map();
const closed = global._keyLifespanClosed;

// Successful usage per window: a connection's rows between since and until
// (its current key: since keySetAt, or "" for every row; a key it had before:
// one of its pastKeys). One grouped pass over the covering index
// idx_uh_conn_ok (connectionId, status, timestamp, cost, tokens).
export function keyUsageSql(windowCount) {
  return `WITH w(id, connectionId, since, until) AS (VALUES ${Array(windowCount).fill("(?, ?, ?, ?)").join(", ")})
    SELECT w.id AS id,
      SUM(u.cost) AS cost,
      COALESCE(SUM(u.promptTokens), 0) + COALESCE(SUM(u.completionTokens), 0) AS tokens,
      MIN(u.timestamp) AS firstAt,
      SUM(CASE WHEN u.timestamp >= ? THEN u.cost ELSE 0 END) AS recentCost,
      SUM(CASE WHEN u.timestamp >= ? THEN COALESCE(u.promptTokens, 0) + COALESCE(u.completionTokens, 0) ELSE 0 END) AS recentTokens
    FROM w CROSS JOIN usageHistory u
    WHERE u.connectionId = w.connectionId AND u.status IN ('ok', 'success')
      AND u.timestamp >= w.since AND u.timestamp <= w.until
    GROUP BY w.id`;
}

// windows: [{ id, connectionId?, since?, until? }]; connectionId defaults to id.
export async function getKeyWindowUsage(windows, recentSince) {
  const db = await getAdapter();
  const out = {};
  for (let i = 0; i < windows.length; i += WINDOW_CHUNK) {
    const chunk = windows.slice(i, i + WINDOW_CHUNK);
    const params = [...chunk.flatMap((w) => [w.id, w.connectionId || w.id, w.since || "", w.until || OPEN]), recentSince, recentSince];
    for (const r of db.all(keyUsageSql(chunk.length), params)) {
      out[r.id] = {
        cost: r.cost || 0, tokens: r.tokens || 0, firstAt: r.firstAt || null,
        recentCost: r.recentCost || 0, recentTokens: r.recentTokens || 0,
      };
    }
  }
  return out;
}

/**
 * Lifespan estimate for every active key of a provider. Returns only ids and
 * numbers, never connection fields. Cached briefly per provider; a change to
 * the provider's connections (toggle, new key, auto-disable) refreshes it.
 */
export async function getKeyLifespans(provider, { now = Date.now() } = {}) {
  if (!provider) return { estimate: null, keys: {} };
  const version = connectionsVersion();
  const hit = cache.get(provider);
  if (hit && hit.version === version && now - hit.ts < CACHE_TTL_MS) return hit.value;

  // Each API key connection's current key, plus each key that died on it
  // before it got a new one (pastKeys), which counts as a dead key of its own.
  // Only API keys get turned off automatically, so OAuth and cookie accounts
  // have no such budget.
  const keys = [];
  for (const c of await getProviderConnections({ provider })) {
    if (c.authType !== "apikey") continue;
    keys.push({ id: c.id, isActive: c.isActive, autoDisabledAt: c.autoDisabledAt || null, since: c.keySetAt || "" });
    (Array.isArray(c.pastKeys) ? c.pastKeys : []).forEach((past, i) => {
      if (!past?.until) return;
      keys.push({ id: `${c.id}#${i}`, connectionId: c.id, isActive: false, autoDisabledAt: past.until, since: past.since || "", until: past.until });
    });
  }
  const usage = {};
  const dead = [];
  const live = [];
  const toRead = [];
  const settledBefore = now - CLOSED_SETTLE_MS;
  for (const k of keys) {
    if (k.isActive !== false) {
      live.push(k);
      continue;
    }
    // Off by hand: neither a sample nor a labelled key.
    if (!k.autoDisabledAt) continue;
    dead.push(k);
    const settled = Date.parse(k.autoDisabledAt) <= settledBefore;
    k.memoKey = settled ? [k.connectionId || k.id, k.since, k.until || OPEN, k.autoDisabledAt].join("|") : null;
    if (k.memoKey && closed.has(k.memoKey)) {
      const u = closed.get(k.memoKey);
      if (u) usage[k.id] = u;
    } else toRead.push(k);
  }
  const recentSince = new Date(now - LIFESPAN_RECENT_WINDOW_MS).toISOString();
  if (toRead.length) Object.assign(usage, await getKeyWindowUsage(toRead, recentSince));
  if (closed.size > CLOSED_CAP) closed.clear();
  for (const k of toRead) if (k.memoKey) closed.set(k.memoKey, usage[k.id] || null);
  let value = estimateKeyLifespans(dead, usage, { now });
  if (value.estimate && live.length) {
    Object.assign(usage, await getKeyWindowUsage(live, recentSince));
    value = estimateKeyLifespans(keys, usage, { now });
  }
  // Drop expired entries so arbitrary provider= values can't grow the map.
  for (const [key, entry] of cache) if (now - entry.ts >= CACHE_TTL_MS || entry.version !== version) cache.delete(key);
  cache.set(provider, { ts: now, version, value });
  return value;
}

export function clearKeyLifespanCache() {
  cache.clear();
  closed.clear();
}
