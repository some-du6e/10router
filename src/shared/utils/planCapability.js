// Which models an account's subscription plan is actually allowed to serve.
//
// A ChatGPT free account cannot run the large Codex models: the upstream
// answers `400 The '<model>' model is not supported when using Codex with a
// ChatGPT account`. Selection used to learn that the expensive way — try the
// account, eat the 400, lock the model for 30s, fall back — which costs a
// round-trip on every turn once the lock expires. Checking the plan we already
// store skips the account outright.

// Free ChatGPT accounts are limited to the small Codex models.
const CODEX_FREE_PLAN_MODELS = new Set(["gpt-5.6-terra", "gpt-5.6-luna"]);

/**
 * The plan recorded for a connection, lowercased, or null when unknown.
 *
 * Same resolution order the account UI uses: an explicit `plan` (which the
 * user can correct by hand) wins over whatever OAuth captured, so a fix in the
 * dashboard takes effect on routing too.
 */
export function resolveConnectionPlan(connection) {
  const plan = connection?.plan
    || connection?.providerSpecificData?.plan
    || connection?.providerSpecificData?.chatgptPlanType
    || null;
  return typeof plan === "string" && plan.trim() ? plan.trim().toLowerCase() : null;
}

/**
 * False only when the plan is known to be unable to serve the model.
 *
 * Fail-open by design: an unrecorded plan, an unrecognised one, or a provider
 * with no plan tiers all return true. A wrong skip strands an account that
 * would have worked, which is worse than the 400 this avoids.
 */
export function planCanServeModel(provider, connection, model) {
  if (provider !== "codex" || !model) return true;
  if (resolveConnectionPlan(connection) !== "free") return true;
  // `-review` variants run the same upstream model under a separate quota.
  const baseModel = String(model).replace(/-review$/, "");
  return CODEX_FREE_PLAN_MODELS.has(baseModel);
}
