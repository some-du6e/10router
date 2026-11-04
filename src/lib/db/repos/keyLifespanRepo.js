import { getAdapter } from "../driver.js";
import { getProviderConnections } from "./connectionsRepo.js";
import { estimateKeyLifespans, LIFESPAN_RECENT_WINDOW_MS } from "../../../shared/utils/keyLifespan.js";

const CACHE_TTL_MS = 60 * 1000;
// Stay well under SQLite's bound-parameter limit on bulk-imported providers.
const ID_CHUNK = 400;

if (!global._keyLifespanCache) global._keyLifespanCache = new Map();
const cache = global._keyLifespanCache;

// Successful usage per connection, in one grouped pass over the covering
// index idx_uh_conn_ok (connectionId, status, timestamp, cost, tokens).
export function keyUsageSql(idCount) {
  return `SELECT connectionId,
      SUM(cost) AS cost,
      SUM(promptTokens) + SUM(completionTokens) AS tokens,
      MIN(timestamp) AS firstAt,
      SUM(CASE WHEN timestamp >= ? THEN cost ELSE 0 END) AS recentCost,
      SUM(CASE WHEN timestamp >= ? THEN promptTokens + completionTokens ELSE 0 END) AS recentTokens
    FROM usageHistory
    WHERE status = 'ok' AND connectionId IN (${Array(idCount).fill("?").join(", ")})
    GROUP BY connectionId`;
}

export async function getKeyUsageByConnection(ids, since) {
  const db = await getAdapter();
  const out = {};
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    for (const r of db.all(keyUsageSql(chunk.length), [since, since, ...chunk])) {
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
    id: c.id, isActive: c.isActive, autoDisabledAt: c.autoDisabledAt || null,
  }));
  const since = new Date(now - LIFESPAN_RECENT_WINDOW_MS).toISOString();
  const usage = connections.length ? await getKeyUsageByConnection(connections.map((c) => c.id), since) : {};
  const value = estimateKeyLifespans(connections, usage, { now });
  cache.set(provider, { ts: now, version, value });
  return value;
}

export function clearKeyLifespanCache() {
  cache.clear();
}
