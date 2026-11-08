// Management keys: scoped keys for /api/management/v1 that can list, create and
// delete client keys and provider keys within their scopes. Client-safe
// helpers shared by the server and the dashboard. See docs/MANAGEMENT_KEYS.md.
import { parseKeyLimitsInput } from "./apiKeyLimits.js";

/**
 * Every management key starts with this. Client keys start with "sk-", so the
 * two can never be mistaken for each other: the gateway refuses a token with
 * this prefix on /v1, and the management API accepts nothing else.
 */
export const MANAGEMENT_KEY_PREFIX = "10r-mgmt-";

const MAX_LIST = 200;
const MAX_ID_LENGTH = 300;
/** Longest name for a management key, a client key or a provider key made through the management API. */
export const MAX_NAME_LENGTH = 120;

/** Is this string shaped like a management key? Says nothing about whether it is valid. */
export function isManagementKeyToken(value) {
  return typeof value === "string" && value.startsWith(MANAGEMENT_KEY_PREFIX);
}

/** Does this token carry a management key anywhere in it? Used to refuse one on /v1 however it is padded. */
export function containsManagementKey(value) {
  return typeof value === "string" && value.includes(MANAGEMENT_KEY_PREFIX);
}

/** No access to either kind of key: what a missing or broken scopes column reads as. */
export function emptyScopes() {
  return {
    clientKeys: { enabled: false, providers: null, models: null, maxBudgetUsd: null, manageExisting: false },
    providerKeys: { enabled: false, providers: null, manageExisting: false },
  };
}

function parseIdList(raw, field, errors) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be an array of ids, or null for no restriction`);
    return null;
  }
  const seen = new Set();
  const list = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      errors.push(`${field} may only contain strings`);
      return null;
    }
    const id = item.trim();
    if (!id) continue;
    if (id.length > MAX_ID_LENGTH) {
      errors.push(`${field} has an id longer than ${MAX_ID_LENGTH} characters`);
      return null;
    }
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    list.push(id);
  }
  if (list.length > MAX_LIST) errors.push(`${field} can list at most ${MAX_LIST} ids`);
  // An empty list would match nothing; null (no restriction) has to be asked for explicitly.
  if (list.length === 0) {
    errors.push(`${field} is empty: list at least one id, or use null for no restriction`);
    return null;
  }
  return list;
}

function parseBool(raw, field, errors) {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") errors.push(`${field} must be true or false`);
  return raw === true;
}

/**
 * Validate a scopes object as the dashboard sends it. Unknown fields are
 * dropped, so a stored scope only ever holds what is enforced.
 *
 * @returns {{ scopes: ReturnType<typeof emptyScopes>, errors: string[] }}
 */
export function normalizeManagementScopes(input) {
  const errors = [];
  const scopes = emptyScopes();
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { scopes, errors: ["scopes must be an object"] };
  }

  const ck = input.clientKeys;
  if (ck !== undefined && ck !== null) {
    if (typeof ck !== "object" || Array.isArray(ck)) errors.push("scopes.clientKeys must be an object");
    else {
      scopes.clientKeys.enabled = parseBool(ck.enabled, "scopes.clientKeys.enabled", errors);
      scopes.clientKeys.providers = parseIdList(ck.providers, "scopes.clientKeys.providers", errors);
      scopes.clientKeys.models = parseIdList(ck.models, "scopes.clientKeys.models", errors);
      scopes.clientKeys.manageExisting = parseBool(ck.manageExisting, "scopes.clientKeys.manageExisting", errors);
      // The same parsing and limits as a client key's own budget.
      const budget = parseKeyLimitsInput({ budgetUsd: ck.maxBudgetUsd ?? null });
      if (budget.errors.length) errors.push(`scopes.clientKeys.maxBudgetUsd: ${budget.errors[0]}`);
      else scopes.clientKeys.maxBudgetUsd = budget.data.budgetUsd ?? null;
    }
  }

  const pk = input.providerKeys;
  if (pk !== undefined && pk !== null) {
    if (typeof pk !== "object" || Array.isArray(pk)) errors.push("scopes.providerKeys must be an object");
    else {
      scopes.providerKeys.enabled = parseBool(pk.enabled, "scopes.providerKeys.enabled", errors);
      scopes.providerKeys.providers = parseIdList(pk.providers, "scopes.providerKeys.providers", errors);
      scopes.providerKeys.manageExisting = parseBool(pk.manageExisting, "scopes.providerKeys.manageExisting", errors);
    }
  }

  if (!scopes.clientKeys.enabled && !scopes.providerKeys.enabled) {
    errors.push("enable client keys, provider keys, or both");
  }
  return { scopes, errors };
}

/** Read a stored scopes column back. Anything malformed grants nothing. */
export function parseStoredScopes(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return emptyScopes(); }
  }
  const { scopes, errors } = normalizeManagementScopes(value);
  // A scope that no longer validates (an edited row, an older format) is not
  // half-applied: it grants nothing until the dashboard saves it again.
  return errors.length ? emptyScopes() : scopes;
}

/** Validate a name (management key, or a key made through the management API). */
export function normalizeManagementKeyName(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "name must be a non-empty string" };
  const name = raw.trim();
  if (name.length > MAX_NAME_LENGTH) return { error: `name can be at most ${MAX_NAME_LENGTH} characters` };
  return { name };
}

/** A one-line summary of a scope, for lists. */
export function describeScopes(scopes) {
  const parts = [];
  const ck = scopes?.clientKeys;
  if (ck?.enabled) {
    const limits = [];
    if (ck.providers) limits.push(`providers ${ck.providers.join(", ")}`);
    if (ck.models) limits.push(`models ${ck.models.join(", ")}`);
    if (ck.maxBudgetUsd !== null && ck.maxBudgetUsd !== undefined) limits.push(`budget ≤ $${ck.maxBudgetUsd}`);
    parts.push(`Client keys${limits.length ? ` (${limits.join("; ")})` : " (any)"}${ck.manageExisting ? ", incl. existing" : ""}`);
  }
  const pk = scopes?.providerKeys;
  if (pk?.enabled) {
    parts.push(`Provider keys${pk.providers ? ` (${pk.providers.join(", ")})` : " (any provider)"}${pk.manageExisting ? ", incl. existing" : ""}`);
  }
  return parts.join(" · ") || "No access";
}
