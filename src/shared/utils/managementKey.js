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

/** The management API docs: scopes, endpoints with curl examples, audit log. */
export const MANAGEMENT_KEYS_DOCS_URL = "https://github.com/some-du6e/10router/blob/master/docs/MANAGEMENT_KEYS.md";

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
    providerKeys: { enabled: false, providers: null, manageExisting: false, baseUrlHosts: null },
  };
}

/** Most host patterns one endpoint's list can hold. */
export const MAX_BASE_URL_HOSTS = 50;
const MAX_HOST_LENGTH = 253;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// OPENAI_COMPATIBLE_PREFIX and ANTHROPIC_COMPATIBLE_PREFIX in
// shared/constants/providers.js, not imported: that module pulls in the whole
// provider registry, and the gateway guard imports this file.
const COMPATIBLE_ENDPOINT_PREFIXES = ["openai-compatible-", "anthropic-compatible-"];

/** Is this a custom OpenAI- or Anthropic-compatible endpoint's id, the only providers whose keys can have their own URL? */
export function isCompatibleEndpointId(id) {
  return typeof id === "string" && COMPATIBLE_ENDPOINT_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * Why this isn't a usable host pattern for scopes.providerKeys.baseUrlHosts,
 * or null when it is. A pattern is an exact host (api.acme.example) or one
 * leading wildcard label (*.acme.example) followed by at least two labels.
 */
export function hostPatternError(pattern) {
  if (typeof pattern !== "string" || !pattern) return "must be a non-empty string";
  if (pattern.length > MAX_HOST_LENGTH) return `can be at most ${MAX_HOST_LENGTH} characters`;
  if (pattern === "*") return "would allow any host; use *.acme.example";
  if (pattern !== pattern.toLowerCase()) return "must be lowercase";
  if (pattern.startsWith("[") || pattern.includes("::")) return "can't be an IP address";
  if (pattern.includes("/")) return "is a host name, not a URL";
  if (pattern.includes(":")) return "can't have a port";
  const wildcard = pattern.startsWith("*.");
  const rest = wildcard ? pattern.slice(2) : pattern;
  if (rest.includes("*")) return "may only have one wildcard, as its first label (*.acme.example)";
  const labels = rest.split(".");
  if (labels.some((l) => !HOST_LABEL.test(l))) return "has a label that isn't letters, digits and hyphens";
  // No top-level domain is all digits, so this catches 10.0.0.1 and *.0.0.1 alike.
  if (/^\d+$/.test(labels[labels.length - 1])) return "can't be an IP address";
  if (labels[labels.length - 1] === "localhost") return "can't be localhost";
  if (labels.length < 2) return wildcard ? "needs at least two labels after *. (*.acme.example)" : "needs at least two labels (api.acme.example)";
  return null;
}

/**
 * Does this host match this pattern? Exact, or *.suffix with exactly one more
 * label: *.acme.example matches key-a.acme.example, not acme.example and not
 * a.b.acme.example.
 */
export function hostMatchesPattern(host, pattern) {
  if (typeof host !== "string" || typeof pattern !== "string") return false;
  if (!pattern.startsWith("*.")) return host === pattern;
  const suffix = pattern.slice(1);
  if (!host.endsWith(suffix)) return false;
  // One real label: not "*", "-" or "a.b".
  return HOST_LABEL.test(host.slice(0, -suffix.length));
}

/** The host patterns the scope allows for this provider's keys, or [] for none. */
export function baseUrlHostsFor(scope, provider) {
  const map = scope?.baseUrlHosts;
  if (!map || typeof provider !== "string") return [];
  const want = provider.trim().toLowerCase();
  const entry = Object.entries(map).find(([id]) => id.toLowerCase() === want);
  return entry ? entry[1] : [];
}

function parseHostPatterns(raw, field, errors) {
  if (!Array.isArray(raw)) {
    errors.push(`${field} must be an array of host patterns`);
    return null;
  }
  const list = [];
  for (const item of raw) {
    const pattern = typeof item === "string" ? item.trim() : item;
    if (pattern === "") continue;
    const why = hostPatternError(pattern);
    if (why) {
      errors.push(`${field}: "${String(pattern).slice(0, 80)}" ${why}`);
      return null;
    }
    if (!list.includes(pattern)) list.push(pattern);
  }
  if (list.length > MAX_BASE_URL_HOSTS) errors.push(`${field} can list at most ${MAX_BASE_URL_HOSTS} patterns`);
  return list.length ? list : null;
}

/**
 * baseUrlHosts: { [endpoint id]: patterns }. Hosts are allowed per endpoint,
 * so a host trusted for one endpoint's keys can't be used to point another
 * endpoint's keys elsewhere. Every id must be a custom compatible endpoint,
 * and inside the scope's providers when it lists some.
 */
function parseHostMap(raw, providers, field, errors) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${field} must be an object of endpoint id to host patterns, or null for none`);
    return null;
  }
  const inScope = providers ? new Set(providers.map((p) => p.toLowerCase())) : null;
  const map = {};
  for (const [rawId, list] of Object.entries(raw)) {
    const id = rawId.trim();
    const shown = `"${id.slice(0, 80)}"`;
    if (!isCompatibleEndpointId(id)) {
      errors.push(`${field}: ${shown} is not a custom OpenAI- or Anthropic-compatible endpoint`);
      return null;
    }
    if (inScope && !inScope.has(id.toLowerCase())) {
      errors.push(`${field}: ${shown} is not one of scopes.providerKeys.providers`);
      return null;
    }
    if (Object.keys(map).some((k) => k.toLowerCase() === id.toLowerCase())) {
      errors.push(`${field}: ${shown} is listed twice`);
      return null;
    }
    const patterns = parseHostPatterns(list, `${field}.${id.slice(0, 80)}`, errors);
    if (patterns) map[id] = patterns;
  }
  if (Object.keys(map).length > MAX_LIST) errors.push(`${field} can list at most ${MAX_LIST} endpoints`);
  return Object.keys(map).length ? map : null;
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
      scopes.providerKeys.baseUrlHosts = parseHostMap(pk.baseUrlHosts, scopes.providerKeys.providers, "scopes.providerKeys.baseUrlHosts", errors);
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
    const own = Object.entries(pk.baseUrlHosts || {}).map(([id, list]) => `${id} on ${list.join(", ")}`);
    const hosts = own.length ? `, own URLs: ${own.join("; ")}` : "";
    parts.push(`Provider keys${pk.providers ? ` (${pk.providers.join(", ")})` : " (any provider)"}${pk.manageExisting ? ", incl. existing" : ""}${hosts}`);
  }
  return parts.join(" · ") || "No access";
}
