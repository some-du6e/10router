// _meta.configGeneration: a counter every config write moves in its own
// transaction, so another process sharing the file (the Go gateway, see
// docs/GO_GATEWAY.md "Config sync") can tell its cached config is stale by
// reading one row. It covers settings, combos, providerNodes, apiKeys, the
// kv scopes in CONFIG_KV_SCOPES, and dashboard edits of providerConnections
// (connectionConfigChanged), never the request path's lock and usage writes.
// tests/unit/config-generation.test.js fails on a write path that skips it.

export const CONFIG_GENERATION_KEY = "configGeneration";

/** The kv scopes the gateway's config snapshot reads. */
export const CONFIG_KV_SCOPES = new Set(["modelAliases", "pricing", "customModels"]);

const BUMP_SQL = `INSERT INTO _meta(key, value) VALUES('${CONFIG_GENERATION_KEY}', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`;

/** Move the generation. Call it inside the transaction that writes the config. */
export function bumpConfigGenerationSync(db) {
  db.run(BUMP_SQL);
}

/** Run fn in a transaction that also moves the generation. */
export function writeConfig(db, fn) {
  return db.transaction(() => {
    const result = fn();
    bumpConfigGenerationSync(db);
    return result;
  });
}

// Connection fields the request path writes on every request or error:
// locks, backoff, errors, auth evidence and demotions, rotation state, token
// refreshes. Writing only these is not a config change.
const RUNTIME_FIELD_PREFIXES = ["modelLock_", "modelLimit_", "modelNoHeaders_", "providerReset_", "authDemote_", "authFail"];
const RUNTIME_FIELDS = new Set([
  "updatedAt", "backoffLevel", "lastError", "lastErrorAt", "errorCode", "testStatus", "lastTested",
  "lastUsedAt", "consecutiveUseCount", "rateLimitedUntil", "authDemoteOkAt", "autoDisabledAt", "autoDisabledReason",
  "accessToken", "refreshToken", "expiresAt", "expiresIn", "tokenType", "idToken", "lastRefreshAt",
  "lastPingAt", "lastPingedResetAt", "lastPingedResetKey",
]);

function isRuntimeField(key) {
  return RUNTIME_FIELDS.has(key) || RUNTIME_FIELD_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Did a providerConnections write change anything but runtime state? `before`
 * and `after` are connection objects as connectionsRepo reads them (columns
 * and data together). isActive is a column, so turning a key off counts.
 */
export function connectionConfigChanged(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (isRuntimeField(key)) continue;
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) return true;
  }
  return false;
}
