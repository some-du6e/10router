// Enforces a client API key's limits (budget, model allowlist, expiry) before a
// request reaches any upstream. Every /v1 handler calls checkApiKeyLimits right
// after its API-key check. A key with no limits costs one indexed read and
// changes nothing. See docs/API_KEY_BUDGETS.md.
import { getApiKeyPolicy, getModelAliases, getSettings } from "@/lib/db/index.js";
import { BUILTIN_MODEL_ALIASES, stripContextWindowSuffix } from "open-sse/services/model.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { buildErrorBody } from "open-sse/utils/error.js";
import { budgetState, isKeyExpired } from "@/shared/utils/apiKeyLimits.js";
import { extractApiKey } from "./auth.js";
import { parseModel, getComboModels, comboLookupName } from "./model.js";

// One row per limit: HTTP status, OpenAI error type/code, Anthropic error type.
// 402 for the budget, not 429: a used-up budget does not clear by waiting, and
// SDKs retry a 429 on their own. OpenRouter answers 402 for spent credit and
// Anthropic's API uses it for billing_error; OpenAI calls it insufficient_quota.
const KEY_LIMITS = {
  budget: { status: HTTP_STATUS.PAYMENT_REQUIRED, type: "insufficient_quota", code: "key_budget_exceeded", claudeType: "billing_error" },
  model: { status: HTTP_STATUS.FORBIDDEN, type: "permission_error", code: "model_not_allowed", claudeType: "permission_error" },
  expired: { status: HTTP_STATUS.UNAUTHORIZED, type: "authentication_error", code: "key_expired", claudeType: "authentication_error" },
};

/** The rejection, shaped like the client's API: Claude on the Messages API, OpenAI everywhere else. */
function limitResponse(kind, message, format) {
  const spec = KEY_LIMITS[kind];
  const { error } = buildErrorBody(spec.status, message);
  const body = format === FORMATS.CLAUDE
    ? { type: "error", error: { type: spec.claudeType, message: error.message } }
    : { error: { ...error, type: spec.type, code: spec.code } };
  return new Response(JSON.stringify(body), {
    status: spec.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// ---- Allowlist matching ------------------------------------------------------

/** "CC/Claude-Opus-5-5[1m]" → "claude/claude-opus-5-5": provider alias resolved, context window and case dropped. */
function canonicalModel(id) {
  if (typeof id !== "string" || !id.trim()) return "";
  const parsed = parseModel(id.trim().toLowerCase());
  return parsed.provider ? `${parsed.provider}/${parsed.model}` : parsed.model || "";
}

function matchesAllowed(requested, allowed) {
  if (allowed.has(requested)) return true;
  // A bare id on the list ("claude-opus-5-5") allows that model from any
  // provider ("cc/claude-opus-5-5"), but only one level deep: "cc/x" on the
  // list is not a bare id, so it doesn't allow "openrouter/cc/x".
  const slash = requested.indexOf("/");
  if (slash <= 0) return false;
  const bare = requested.slice(slash + 1);
  return !bare.includes("/") && allowed.has(bare);
}

/** What allowlist matching reads from the router's config: aliases, and combo members with any fusion judge. */
async function allowlistLookup() {
  const [aliases, settings] = await Promise.all([
    getModelAliases().catch(() => ({})),
    getSettings().catch(() => ({})),
  ]);
  return {
    aliases: { ...BUILTIN_MODEL_ALIASES, ...(aliases || {}) },
    comboModels: async (name) => {
      const members = await getComboModels(name);
      if (!Array.isArray(members) || members.length === 0) return null;
      // A fusion combo's answer can come from its judge, so the judge is a member too.
      const strategy = settings?.comboStrategies?.[comboLookupName(name)] || {};
      const fusion = (strategy.fallbackStrategy || settings?.comboStrategy) === "fusion";
      const judge = fusion && typeof strategy.judgeModel === "string" ? strategy.judgeModel.trim() : "";
      return judge ? [...members, judge] : members;
    },
  };
}

/**
 * May a key with this allowlist request this model?
 *
 * Allowed when the model is on the list, when it is an alias whose target is
 * on the list, or when it is a combo whose every member (and fusion judge) is
 * allowed. A combo named on the list is allowed as a whole.
 *
 * @param {string} requested model id as the client sent it
 * @param {string[]|null} allowedModels null or empty = everything allowed
 * @param {{ aliases?: Record<string, string>, comboModels?: (name: string) => Promise<string[]|null> }} lookup
 */
export async function isModelAllowed(requested, allowedModels, lookup, depth = 0) {
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return true;
  const req = canonicalModel(requested);
  if (!req) return false;
  const allowed = new Set(allowedModels.map(canonicalModel).filter(Boolean));
  if (matchesAllowed(req, allowed)) return true;

  const raw = stripContextWindowSuffix(String(requested).trim()).model;
  const target = lookup?.aliases?.[raw];
  if (typeof target === "string" && matchesAllowed(canonicalModel(target), allowed)) return true;

  // The depth cap stops a combo that (mis)lists itself from looping.
  if (depth < 3 && !raw.includes("/") && lookup?.comboModels) {
    const members = await lookup.comboModels(raw);
    if (Array.isArray(members) && members.length > 0) {
      for (const member of members) {
        if (!(await isModelAllowed(member, allowedModels, lookup, depth + 1))) return false;
      }
      return true;
    }
  }
  return false;
}

// ---- Request checks ----------------------------------------------------------

/**
 * Why this key may not make this request, or null when it may.
 * @param {string|null} apiKey the raw key from the request
 * @param {{ model?: string|null, format?: string }} [opts]
 * @returns {Promise<{ status: number, message: string, response: Response }|null>}
 */
export async function apiKeyLimitDenial(apiKey, { model = null, format = FORMATS.OPENAI } = {}) {
  if (!apiKey) return null;
  const key = await getApiKeyPolicy(apiKey);
  if (!key) return null;

  let kind = null;
  let message = "";
  if (isKeyExpired(key)) {
    kind = "expired";
    message = `This API key expired on ${new Date(key.expiresAt).toISOString()}. Ask its owner for a new key or a later expiry date.`;
  } else if (key.allowedModels?.length && !(model && await isModelAllowed(model, key.allowedModels, await allowlistLookup()))) {
    kind = "model";
    const what = model ? `model "${model}"` : "a request without a model";
    message = `This API key is not allowed to use ${what}. It may use: ${key.allowedModels.join(", ")}.`;
  } else {
    const budget = budgetState(key);
    if (budget.exhausted) {
      kind = "budget";
      message = `This API key's budget is used up: it has spent ${fmtUsd(budget.spentUsd)} of its ${fmtUsd(budget.budgetUsd)} budget. Ask its owner to raise the budget or reset its spend.`;
    }
  }
  if (!kind) return null;
  return { status: KEY_LIMITS[kind].status, message, response: limitResponse(kind, message, format) };
}

/**
 * Check the limits of the key on this request. Runs before any upstream call.
 *
 * @param {string|null} apiKey the raw key from the request
 * @param {{ model?: string|null, format?: string }} [opts]
 * @returns {Promise<Response|null>} the rejection, or null to go ahead
 */
export async function checkApiKeyLimits(apiKey, opts) {
  return (await apiKeyLimitDenial(apiKey, opts))?.response || null;
}

/** Does this key have a spend budget? Its streams are drained on hang-up for real usage. */
export async function keyHasBudget(apiKey) {
  if (!apiKey) return false;
  const key = await getApiKeyPolicy(apiKey);
  return typeof key?.budgetUsd === "number";
}

/** Expiry only: for calls that spend nothing and name no model (polling a video job the key already paid for). */
export async function checkApiKeyExpiry(apiKey, { format = FORMATS.OPENAI } = {}) {
  if (!apiKey) return null;
  const key = await getApiKeyPolicy(apiKey);
  if (!key || !isKeyExpired(key)) return null;
  return limitResponse("expired", `This API key expired on ${new Date(key.expiresAt).toISOString()}. Ask its owner for a new key or a later expiry date.`, format);
}

/**
 * Drop the capacity-adapter models a key isn't allowed to use. The request's
 * own models were checked on the way in; the adapter adds the owner's pool on
 * top, which an allowlisted key must not reach. A key with no allowlist keeps them all.
 *
 * @param {string|null} apiKey
 * @param {string[]} augmented the models with the adapter's additions
 * @param {string[]} original the models before the adapter ran
 */
export async function keepAllowedAdapterModels(apiKey, augmented, original) {
  if (!apiKey || augmented.length === original.length) return augmented;
  const key = await getApiKeyPolicy(apiKey);
  if (!key?.allowedModels?.length) return augmented;
  const lookup = await allowlistLookup();
  const kept = [];
  for (const m of augmented) {
    if (original.includes(m) || await isModelAllowed(m, key.allowedModels, lookup)) kept.push(m);
  }
  return kept;
}

/** An OpenAI-style entry listed under the allowlist's own name. */
const renameOpenAIEntry = (model, id) => ({ ...model, id, owned_by: "10router" });

/**
 * The model list a key may see: only its allowed models when it has an
 * allowlist, the whole list otherwise (and for a request with no key).
 *
 * A key with an allowlist sees each entry under the name it was allowed by:
 * a bare entry ("claude-opus-5-5") is listed once, bare, not as every
 * provider-prefixed id that serves it, so the list doesn't reveal which
 * providers or custom endpoints sit behind the key. A prefixed entry is
 * listed as-is.
 *
 * @param {Request} request
 * @param {object[]} models
 * @param {(model: object) => string} [idOf] the entry's model id
 * @param {(model: object, id: string) => object} [rename] the entry listed as `id`
 * @param {{ everyId?: boolean }} [options] everyId: also list each allowed
 *   entry under its own id, next to the allowlist name, for a client that
 *   looks models up by the exact id it was configured with (Codex's catalog)
 */
export async function filterModelsForRequest(request, models, idOf = (m) => m?.id, rename = renameOpenAIEntry, { everyId = false } = {}) {
  const apiKey = request?.headers ? extractApiKey(request) : null;
  if (!apiKey || !Array.isArray(models)) return models;
  const key = await getApiKeyPolicy(apiKey);
  if (!key?.allowedModels?.length) return models;
  const lookup = await allowlistLookup();
  const bareEntries = key.allowedModels.filter((e) => typeof e === "string" && e && !e.includes("/"));
  const visible = [];
  const listed = new Set();
  for (const model of models) {
    const id = idOf(model);
    // Whole-allowlist check, so a combo whose members different entries allow still shows.
    if (!(await isModelAllowed(id, key.allowedModels, lookup))) continue;
    // Bare ids (combos, bare catalog ids) carry no provider: listed as they are.
    let shownAs = id;
    if (typeof id === "string" && id.includes("/")) {
      for (const entry of bareEntries) {
        if (await isModelAllowed(id, [entry], lookup)) { shownAs = entry; break; }
      }
    }
    const names = shownAs === id ? [[id, model]] : [[shownAs, rename(model, shownAs)]];
    if (everyId && shownAs !== id) names.push([id, model]);
    for (const [name, entry] of names) {
      if (listed.has(name)) continue;
      listed.add(name);
      visible.push(entry);
    }
  }
  return visible;
}
