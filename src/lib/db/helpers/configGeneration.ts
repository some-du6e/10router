// _meta.configGeneration: a counter every config write moves in its own
// transaction, so another process sharing the file (the Go gateway, see
// docs/GO_GATEWAY.md "Config sync") can tell its cached config is stale by
// reading one row. It covers settings, combos, providerNodes, apiKeys, the
// kv scopes in CONFIG_KV_SCOPES, and dashboard edits of providerConnections
// (connectionConfigChanged), never the request path's lock and usage writes.
// tests/unit/config-generation.test.js fails on a write path that skips it.

const CONFIG_GENERATION_KEY = "configGeneration";

/** The kv scopes the gateway's config snapshot reads. */
export const CONFIG_KV_SCOPES: ReadonlySet<string> = new Set(["modelAliases", "pricing", "customModels"]);

const BUMP_SQL = `INSERT INTO _meta(key, value) VALUES('${CONFIG_GENERATION_KEY}', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`;

/** The part of a database adapter (src/lib/db/adapters) these helpers use. */
export interface ConfigWriteDb {
  run(sql: string, params?: unknown[]): unknown;
  transaction<T>(fn: () => T): T;
}

/** Move the generation. Call it inside the transaction that writes the config. */
export function bumpConfigGenerationSync(db: Pick<ConfigWriteDb, "run">): void {
  db.run(BUMP_SQL);
}

/** Run fn in a transaction that also moves the generation. */
export function writeConfig<T>(db: ConfigWriteDb, fn: () => T): T {
  return db.transaction(() => {
    const result = fn();
    bumpConfigGenerationSync(db);
    return result;
  });
}

// Connection fields the request path writes on every request or error:
// locks, backoff, errors, auth evidence and demotions, rotation state, token
// refreshes. Writing only these is not a config change.
const RUNTIME_FIELD_PREFIXES: readonly string[] = ["modelLock_", "modelLimit_", "modelNoHeaders_", "providerReset_", "authDemote_", "authFail"];
const RUNTIME_FIELDS: ReadonlySet<string> = new Set([
  "updatedAt", "backoffLevel", "lastError", "lastErrorAt", "errorCode", "testStatus", "lastTested",
  "lastUsedAt", "consecutiveUseCount", "rateLimitedUntil", "authDemoteOkAt", "autoDisabledAt", "autoDisabledReason",
  "accessToken", "refreshToken", "expiresAt", "expiresIn", "tokenType", "idToken", "lastRefreshAt",
  "lastPingAt", "lastPingedResetAt", "lastPingedResetKey",
]);

function isRuntimeField(key: string): boolean {
  return RUNTIME_FIELDS.has(key) || RUNTIME_FIELD_PREFIXES.some((p) => key.startsWith(p));
}

type ConnectionFields = Record<string, unknown> | null | undefined;

/** A token refresh's own fields, which count as runtime state for that write (connectionConfigChanged). */
export interface RefreshedFields {
  /** Top-level connection fields the refresh result writes (buildCredentialUpdates). */
  fields?: Iterable<string>;
  /** providerSpecificData keys its patch writes (Copilot's token, a project or account id). */
  providerSpecificData?: Iterable<string>;
}

/** The fields a token refresh result writes, from its connection update (credentialSave.js). */
export function refreshedFields(update: Record<string, unknown> | null | undefined): RefreshedFields {
  const psd = update?.providerSpecificData;
  return {
    fields: Object.keys(update || {}).filter((key) => key !== "providerSpecificData"),
    providerSpecificData: psd && typeof psd === "object" ? Object.keys(psd) : [],
  };
}

const json = (value: unknown): string | undefined => JSON.stringify(value ?? null);

/**
 * Did a providerConnections write change anything but runtime state? `before`
 * and `after` are connection objects as connectionsRepo reads them (columns
 * and data together). isActive is a column, so turning a key off counts.
 *
 * `refreshed` names what a token refresh wrote: those fields, and those keys
 * of providerSpecificData, are runtime for this write. A refresh rewrites
 * tokens on a timer; the gateway reads connections fresh at pick time, so
 * reloading its whole config snapshot for one would buy nothing.
 */
export function connectionConfigChanged(before: ConnectionFields, after: ConnectionFields, refreshed: RefreshedFields | null = null): boolean {
  const refreshedTop = new Set(refreshed?.fields || []);
  const refreshedPsd = new Set(refreshed?.providerSpecificData || []);
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (isRuntimeField(key) || refreshedTop.has(key)) continue;
    if (key === "providerSpecificData" && refreshedPsd.size > 0) {
      if (providerSpecificDataChanged(before?.[key], after?.[key], refreshedPsd)) return true;
      continue;
    }
    if (json(before?.[key]) !== json(after?.[key])) return true;
  }
  return false;
}

// providerSpecificData compared key by key, leaving out the keys a refresh
// wrote. A missing one is empty: the refresh's patch is applied over `{}`.
function providerSpecificDataChanged(before: unknown, after: unknown, skip: ReadonlySet<string>): boolean {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  before ??= {};
  after ??= {};
  if (!isObject(before) || !isObject(after)) return json(before) !== json(after);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (skip.has(key)) continue;
    if (json(before[key]) !== json(after[key])) return true;
  }
  return false;
}
