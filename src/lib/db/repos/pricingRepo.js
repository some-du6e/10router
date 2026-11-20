import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, user: null, expiresAt: 0 };
let generation = 0;

function invalidate() {
  generation += 1;
  cache = { value: null, user: null, expiresAt: 0 };
}

/**
 * Bust the cached merged pricing map. Call after any write to the `pricing`
 * kv scope (see updatePricing/resetPricing/resetAllPricing, and importDb for
 * the restore path) so the next read rebuilds from the DB.
 */
export function invalidatePricingCache() {
  invalidate();
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

async function loadPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache;

  // A read that started before an invalidation must not publish stale pricing.
  const startGeneration = generation;
  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  const entry = { value: merged, user: userPricing, expiresAt: now + CACHE_TTL_MS };
  if (startGeneration === generation) cache = entry;
  return entry;
}

export async function getPricing() {
  return (await loadPricing()).value;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  // Read through the cached pricing instead of re-running the pricing SELECT +
  // JSON.parse on every request. Return the raw user override (not the merged
  // entry) so partial overrides cost exactly as they did before caching.
  const { user } = await loadPricing();
  if (provider && user[provider]?.[model]) return user[provider][model];
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}
