import { getAdapter } from "../driver.js";
import { getProviderConnections } from "./connectionsRepo.js";
import { estimateKeyLifespans, LIFESPAN_RECENT_WINDOW_MS } from "../../../shared/utils/keyLifespan.js";

const CACHE_TTL_MS = 60 * 1000;
// Stay well under SQLite's bound-parameter limit (999 on old builds) on
// bulk-imported providers: two per key.
const ID_CHUNK = 400;

if (!global._keyLifespanCache) global._keyLifespanCache = new Map();
const cache = global._keyLifespanCache;

// Successful usage per connection since its current key was stored (keySetAt;
// "" counts every row), in one grouped pass over the covering index
// idx_uh_conn_ok (connectionId, status, timestamp, cost, tokens).
export function keyUsageSql(idCount) {
  return `WITH k(id, since) AS (VALUES ${Array(idCount).fill("(?, ?)").join(", ")})
    SELECT k.id AS connectionId,
      SUM(u.cost) AS cost,
      SUM(u.promptTokens) + SUM(u.completionTokens) AS tokens,
      MIN(u.timestamp) AS firstAt,
      SUM(CASE WHEN u.timestamp >= ? THEN u.cost ELSE 0 END) AS recentCost,
      SUM(CASE WHEN u.timestamp >= ? THEN u.promptTokens + u.completionTokens ELSE 0 END) AS recentTokens
    FROM k CROSS JOIN usageHistory u
    WHERE u.connectionId = k.id AND u.status = 'ok' AND u.timestamp >= k.since
    GROUP BY k.id`;
}

// keys: [{ id, since? }]
export async function getKeyUsageByConnection(keys, recentSince) {
  const db = await getAdapter();
  const out = {};
  for (let i = 0; i < keys.length; i += ID_CHUNK) {
    const chunk = keys.slice(i, i + ID_CHUNK);
    const params = [...chunk.flatMap((k) => [k.id, k.since || ""]), recentSince, recentSince];
    for (const r of db.all(keyUsageSql(chunk.length), params)) {
      out[r.connectionId] = {
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
export async function getKeyLifespans(provider, opts = {}) {
  if (!provider) return { estimate: null, keys: {} };
  const now = opts.now ?? Date.now();
  const version = global._connectionsVersion || 0;
  const hit = cache.get(provider);
  if (!opts.fresh && hit && hit.version === version && now - hit.ts < CACHE_TTL_MS) return hit.value;

  const connections = (await getProviderConnections({ provider })).map((c) => ({
    id: c.id, isActive: c.isActive, autoDisabledAt: c.autoDisabledAt || null, since: c.keySetAt || "",
  }));
  const recentSince = new Date(now - LIFESPAN_RECENT_WINDOW_MS).toISOString();
  const usage = connections.length ? await getKeyUsageByConnection(connections, recentSince) : {};
  const value = estimateKeyLifespans(connections, usage, { now });
  cache.set(provider, { ts: now, version, value });
  return value;
}

export function clearKeyLifespanCache() {
  cache.clear();
}
