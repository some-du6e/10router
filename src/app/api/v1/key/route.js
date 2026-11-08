import { extractApiKey } from "@/sse/services/auth.js";
import { getApiKeyPolicy } from "@/lib/db/repos/apiKeysRepo.js";
import { budgetState, isKeyExpired } from "@/shared/utils/apiKeyLimits.js";
import { maskApiKey } from "@/shared/utils/apiKey.js";

export const dynamic = "force-dynamic";

const CORS = { "Access-Control-Allow-Origin": "*" };

function unauthorized(message) {
  return Response.json(
    { error: { message, type: "authentication_error", code: "invalid_api_key" } },
    { status: 401, headers: CORS }
  );
}

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
  if (!apiKey) return unauthorized("Missing API key");
  const key = await getApiKeyPolicy(apiKey);
  if (!key) return unauthorized("Invalid API key");

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
