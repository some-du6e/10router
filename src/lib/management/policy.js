// What a management key may do: the scope checks for the client keys it hands
// out, the providers it may add keys for, and which existing rows it can see.
// See docs/MANAGEMENT_KEYS.md.
import { isModelAllowed } from "@/sse/services/keyLimits.js";
import { getModelInfo } from "@/sse/services/model.js";
import { resolveProviderAlias, stripContextWindowSuffix } from "open-sse/services/model.js";
import { normalizeProviderId } from "@/lib/providerNormalization";

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

/** The provider a provider/model allowlist entry routes to: aliases resolved, custom node prefixes mapped to node ids. */
async function entryProvider(entry) {
  const raw = stripContextWindowSuffix(String(entry || "").trim()).model;
  if (!raw.includes("/")) return null;
  const info = await getModelInfo(raw);
  return info?.provider ? String(info.provider).toLowerCase() : null;
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
 */
export async function clientKeyScopeViolation(scope, { allowedModels, budgetUsd }) {
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
      if (providers && !providers.has(await entryProvider(m))) {
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

/** Rows it created, or every row when manageExisting is on. */
function ownsOrManages(scope, ownerId, managementKeyId) {
  return (!!ownerId && ownerId === managementKeyId) || scope?.manageExisting === true;
}

/**
 * Can this management key see (and so edit or delete) this client key? The
 * key must also be inside its current scope, so narrowing a scope takes
 * effect on keys it already created.
 */
export async function clientKeyVisible(managementKey, apiKey, ownerId) {
  const scope = managementKey.scopes.clientKeys;
  if (!scope.enabled || !ownsOrManages(scope, ownerId, managementKey.id)) return false;
  return (await clientKeyScopeViolation(scope, apiKey)) === null;
}

/** Same for a provider connection: its provider must be in scope. */
export function providerKeyVisible(managementKey, connection, ownerId) {
  const scope = managementKey.scopes.providerKeys;
  if (!scope.enabled || !ownsOrManages(scope, ownerId, managementKey.id)) return false;
  return providerInScope(scope, connection.provider);
}
