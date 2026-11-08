// Enforces a client API key's limits (budget, model allowlist, expiry) before a
// request reaches any upstream. Every /v1 handler calls checkApiKeyLimits right
// after its API-key check. A key with no limits costs one indexed read and
// changes nothing. See docs/API_KEY_BUDGETS.md.
import { getApiKeyPolicy } from "@/lib/db/repos/apiKeysRepo.js";
import { extractApiKey } from "./auth.js";
import { getModelAliases } from "@/lib/db/repos/aliasRepo.js";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { BUILTIN_MODEL_ALIASES } from "open-sse/services/model.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { budgetState, isKeyExpired, isModelAllowed } from "@/shared/utils/apiKeyLimits.js";

// 402, not 429: a used-up budget does not clear by waiting, and SDKs retry a
// 429 on their own. 402 is what OpenRouter returns for spent credit and what
// Anthropic's API uses for billing_error.
export const KEY_LIMIT_STATUS = {
  budget: HTTP_STATUS.PAYMENT_REQUIRED,
  model: HTTP_STATUS.FORBIDDEN,
  expired: HTTP_STATUS.UNAUTHORIZED,
};

// Error `type` per client wire format. OpenAI's own spent-credit error is
// insufficient_quota; Anthropic's is billing_error.
const ERROR_TYPES = {
  budget: { openai: "insufficient_quota", claude: "billing_error", code: "key_budget_exceeded" },
  model: { openai: "permission_error", claude: "permission_error", code: "model_not_allowed" },
  expired: { openai: "authentication_error", claude: "authentication_error", code: "key_expired" },
};

function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

/**
 * The rejection for a key limit, shaped like the client's API: Claude
 * `{"type":"error","error":{...}}` on the Messages API, OpenAI
 * `{"error":{...}}` everywhere else.
 */
export function keyLimitResponse(kind, message, format) {
  const types = ERROR_TYPES[kind];
  const body = format === FORMATS.CLAUDE
    ? { type: "error", error: { type: types.claude, message } }
    : { error: { message, type: types.openai, code: types.code } };
  return new Response(JSON.stringify(body), {
    status: KEY_LIMIT_STATUS[kind],
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function allowlistLookup() {
  let aliases = {};
  try { aliases = await getModelAliases(); } catch { /* no aliases */ }
  return {
    aliases: { ...BUILTIN_MODEL_ALIASES, ...(aliases || {}) },
    getComboModels: async (name) => {
      const combo = await getComboByName(name);
      return combo?.models?.length ? combo.models : null;
    },
  };
}

/**
 * Why this key may not make this request, or null when it may.
 *
 * @param {object|null} key the key's policy (getApiKeyPolicy)
 * @param {{ model?: string|null, checkModel?: boolean, checkBudget?: boolean, now?: number }} [opts]
 * @returns {Promise<{ kind: "budget"|"model"|"expired", message: string }|null>}
 */
export async function keyLimitViolation(key, { model = null, checkModel = true, checkBudget = true, now = Date.now() } = {}) {
  if (!key) return null;

  if (isKeyExpired(key, now)) {
    return { kind: "expired", message: `This API key expired on ${new Date(key.expiresAt).toISOString()}. Ask its owner for a new key or a later expiry date.` };
  }

  if (checkModel && Array.isArray(key.allowedModels) && key.allowedModels.length > 0) {
    const allowed = model ? await isModelAllowed(model, key.allowedModels, await allowlistLookup()) : false;
    if (!allowed) {
      const what = model ? `model "${model}"` : "a request without a model";
      return { kind: "model", message: `This API key is not allowed to use ${what}. It may use: ${key.allowedModels.join(", ")}.` };
    }
  }

  if (checkBudget) {
    const budget = budgetState(key);
    if (budget.exhausted) {
      return {
        kind: "budget",
        message: `This API key's budget is used up: it has spent ${fmtUsd(budget.spentUsd)} of its ${fmtUsd(budget.budgetUsd)} budget. Ask its owner to raise the budget or reset its spend.`,
      };
    }
  }

  return null;
}

/**
 * Check the limits of the key on this request. Runs before any upstream call.
 *
 * @param {string|null} apiKey the raw key from the request
 * @param {{ model?: string|null, format?: string, checkModel?: boolean, checkBudget?: boolean }} [opts]
 * @returns {Promise<Response|null>} the rejection, or null to go ahead
 */
export async function checkApiKeyLimits(apiKey, { format = FORMATS.OPENAI, ...opts } = {}) {
  if (!apiKey) return null;
  const key = await getApiKeyPolicy(apiKey);
  const violation = await keyLimitViolation(key, opts);
  if (!violation) return null;
  return keyLimitResponse(violation.kind, violation.message, format);
}

/**
 * The model list a key may see: only its allowed models when it has an
 * allowlist, the whole list otherwise (and for a request with no key).
 *
 * @param {Request} request
 * @param {{ id: string }[]} models
 */
export async function filterModelsForRequest(request, models) {
  const apiKey = request?.headers ? extractApiKey(request) : null;
  if (!apiKey || !Array.isArray(models)) return models;
  const key = await getApiKeyPolicy(apiKey);
  if (!key?.allowedModels?.length) return models;
  const lookup = await allowlistLookup();
  const visible = [];
  for (const model of models) {
    if (await isModelAllowed(model?.id, key.allowedModels, lookup)) visible.push(model);
  }
  return visible;
}
