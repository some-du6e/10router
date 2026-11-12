// What a management key may do: the scope checks for the client keys it hands
// out, the providers it may add keys for, and which existing rows it can see.
// See docs/MANAGEMENT_KEYS.md.
import { isModelAllowed } from "@/sse/services/keyLimits.js";
import { getModelInfo } from "@/sse/services/model.js";
import { resolveProviderAlias, stripContextWindowSuffix } from "open-sse/services/model.js";
import { normalizeProviderId } from "@/lib/providerNormalization";
import { normalizeEndpointUrl } from "@/shared/utils/endpointUrl";
import { hostMatchesPattern, baseUrlHostsFor } from "@/shared/utils/managementKey.js";
// Checked again inside the write that applies it (updateApiKeyAs).
export { dashboardChoiceViolation } from "@/lib/db/repos/managementKeysRepo.js";

// isModelAllowed with nothing to expand: plain id matching, so an entry is in
// scope only by what it names, never by what an alias or combo points to today.
const NO_EXPANSION = Object.freeze({ aliases: {}, comboModels: null });

/** "cc" → "claude", "OpenAI" → "openai"; custom node ids stay as they are. */
export function canonicalProviderId(id) {
  if (typeof id !== "string" || !id.trim()) return "";
  return String(resolveProviderAlias(normalizeProviderId(id.trim())) || "").toLowerCase();
}

function providerSet(list) {
  return new Set((list || []).map(canonicalProviderId).filter(Boolean));
}

function isQualified(entry) {
  return stripContextWindowSuffix(String(entry || "").trim()).model.includes("/");
}

/**
 * Resolves the provider a provider/model allowlist entry routes to (aliases
 * resolved, custom node prefixes mapped to node ids), once per entry. Make one
 * per request: a listing checks every key's entries, and each lookup reads the
 * provider nodes.
 */
export function makeProviderResolver() {
  const cache = new Map();
  return (entry) => {
    const raw = stripContextWindowSuffix(String(entry || "").trim()).model;
    if (!raw.includes("/")) return Promise.resolve(null);
    if (!cache.has(raw)) {
      cache.set(raw, getModelInfo(raw).then((info) => (info?.provider ? String(info.provider).toLowerCase() : null)));
    }
    return cache.get(raw);
  };
}

/** Is this client-key scope restricted to some providers or models? */
export function clientScopeRestrictsModels(scope) {
  return !!(scope?.providers?.length || scope?.models?.length);
}

/**
 * Why a client key with these limits is outside the scope, or null when it is inside.
 *
 * Under a provider or model restriction every allowlist entry must be a
 * provider/model id inside it. A bare id, alias or combo on a client key's
 * allowlist also allows "<any provider>/<that name>" at request time, so one
 * is accepted only when the scope's own models list that same bare id (and the
 * scope has no provider restriction, which a bare id would step outside).
 *
 * @param {object} scope scopes.clientKeys
 * @param {{ allowedModels: string[]|null, budgetUsd: number|null }} limits the key's limits after the change
 * @param {(entry: string) => Promise<string|null>} [resolveProvider] from makeProviderResolver
 */
export async function clientKeyScopeViolation(scope, { allowedModels, budgetUsd }, resolveProvider = makeProviderResolver()) {
  if (!scope?.enabled) return "this management key can't manage client keys";
  const models = Array.isArray(allowedModels) ? allowedModels : [];
  if (clientScopeRestrictsModels(scope)) {
    if (models.length === 0) {
      return "allowedModels is required: this management key may only create keys limited to its providers or models";
    }
    const providers = scope.providers?.length ? providerSet(scope.providers) : null;
    for (const m of models) {
      if (providers && !isQualified(m)) {
        return `model "${m}" is not a provider/model id: this management key may only allow models of its providers (${scope.providers.join(", ")})`;
      }
      if (scope.models?.length && !(await isModelAllowed(m, scope.models, NO_EXPANSION))) {
        return `model "${m}" is outside this management key's models (${scope.models.join(", ")})`;
      }
      if (providers && !providers.has(await resolveProvider(m))) {
        return `model "${m}" is outside this management key's providers (${scope.providers.join(", ")})`;
      }
    }
  }
  if (scope.maxBudgetUsd !== null && scope.maxBudgetUsd !== undefined) {
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd)) {
      return `budgetUsd is required: this management key's keys must have a budget of at most $${scope.maxBudgetUsd}`;
    }
    if (budgetUsd > scope.maxBudgetUsd) {
      return `budgetUsd $${budgetUsd} is above this management key's cap of $${scope.maxBudgetUsd}`;
    }
  }
  return null;
}

/** May this management key add or see connections of this provider? */
export function providerInScope(scope, provider) {
  if (!scope?.enabled) return false;
  if (!scope.providers?.length) return true;
  return providerSet(scope.providers).has(canonicalProviderId(provider));
}

export const MAX_BASE_URL_LENGTH = 2048;
const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Check a provider key's own baseUrl against the host patterns the dashboard
 * gave this scope for that provider. The path is free; the host, scheme and
 * port are not.
 * Errors never quote the URL, which can carry a token in its query.
 *
 * @returns {{ url: string, host: string } | { error: string, host?: string, outsideScope?: true }}
 *   outsideScope marks the refusals that are about the scope (audited), not the URL's shape.
 */
export function keyBaseUrlCheck(scope, provider, raw) {
  const patterns = baseUrlHostsFor(scope, provider);
  if (!patterns.length) {
    return { error: `This management key can't set baseUrl: the dashboard hasn't allowed it any hosts for "${provider}"`, outsideScope: true };
  }
  if (typeof raw !== "string" || !raw.trim()) return { error: "baseUrl must be a URL" };
  if (raw.length > MAX_BASE_URL_LENGTH) return { error: `baseUrl can be at most ${MAX_BASE_URL_LENGTH} characters` };
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return { error: "baseUrl isn't a valid URL" }; }
  if (parsed.protocol !== "https:") return { error: "baseUrl must use https" };
  if (parsed.username || parsed.password) return { error: "baseUrl can't contain a user name or password" };
  // The URL parser drops a default :443, so any port left is another one.
  if (parsed.port) return { error: "baseUrl can't name a port other than 443" };
  const host = parsed.hostname;
  if (host.startsWith("[") || IPV4_HOST.test(host)) return { error: "baseUrl can't be an IP address" };
  const bare = host.replace(/\.$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return { error: "baseUrl can't point at localhost" };
  if (!patterns.some((p) => hostMatchesPattern(host, p))) {
    return { error: `baseUrl host "${host}" isn't one this management key may use (${patterns.join(", ")})`, host, outsideScope: true };
  }
  // Stored in the parser's own serialization, so what routing later parses is what was checked.
  // No fragment: routing appends its API path, which would land after it.
  parsed.hash = "";
  return { url: normalizeEndpointUrl(parsed.href), host };
}

/** Rows it created, or every row when manageExisting is on. */
function ownsOrManages(scope, ownerId, managementKeyId) {
  return (!!ownerId && ownerId === managementKeyId) || scope?.manageExisting === true;
}

/**
 * Can this management key see (and so edit or delete) this client key? The
 * key must also be inside its current scope, so narrowing a scope takes
 * effect on keys it already created.
 */
export async function clientKeyVisible(managementKey, apiKey, ownerId, resolveProvider) {
  const scope = managementKey.scopes.clientKeys;
  if (!scope.enabled || !ownsOrManages(scope, ownerId, managementKey.id)) return false;
  return (await clientKeyScopeViolation(scope, apiKey, resolveProvider)) === null;
}

/**
 * Same for a provider connection: its provider must be in scope, and it must
 * be an API key. OAuth logins and session cookies are never reachable, even
 * with manageExisting.
 */
export function providerKeyVisible(managementKey, connection, ownerId) {
  const scope = managementKey.scopes.providerKeys;
  if (!scope.enabled || connection.authType !== "apikey" || !ownsOrManages(scope, ownerId, managementKey.id)) return false;
  return providerInScope(scope, connection.provider);
}
