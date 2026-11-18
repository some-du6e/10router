import { extractApiKey } from "@/sse/services/auth.js";
import { getApiKeyPolicy, maskApiKey } from "@/lib/db/index.js";
import { budgetState, isKeyExpired } from "@/shared/utils/apiKeyLimits.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      ...CORS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/key — the calling key's own limits and spend, for the person holding
 * it. Answers only about the key on the request, like OpenRouter's
 * GET /api/v1/key. `limit`, `usage` and `limit_remaining` use OpenRouter's names.
 */
export async function GET(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  const key = await getApiKeyPolicy(apiKey);
  if (!key) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");

  const budget = budgetState(key);
  return Response.json({
    data: {
      name: key.name || null,
      label: maskApiKey(key.key),
      is_active: key.isActive,
      limit: budget.budgetUsd,
      usage: budget.spentUsd,
      limit_remaining: budget.remainingUsd,
      budget_exhausted: budget.exhausted,
      lifetime_usage: key.lifetimeSpentUsd,
      usage_reset_at: key.spendResetAt,
      requests: key.requestCount,
      last_used_at: key.lastUsedAt,
      allowed_models: key.allowedModels,
      expires_at: key.expiresAt,
      expired: isKeyExpired(key),
      created_at: key.createdAt || null,
    },
  }, { headers: CORS });
}
