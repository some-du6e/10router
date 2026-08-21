// Which models an account's subscription plan is actually allowed to serve.
//
// A ChatGPT free account cannot run the large Codex models: the upstream
// answers `400 The '<model>' model is not supported when using Codex with a
// ChatGPT account`. Selection used to learn that the expensive way — try the
// account, eat the 400, lock the model for 30s, fall back — which costs a
// round-trip on every turn once the lock expires. Checking the plan we already
// store skips the account outright.

import { getModelUpstreamId } from "open-sse/config/providerModels.js";
import { normalizePlan } from "@/shared/utils/plans.js";

// Free ChatGPT accounts are limited to the small Codex models.
const CODEX_FREE_PLAN_MODELS = new Set(["gpt-5.6-terra", "gpt-5.6-luna"]);

// Kept in step with the suffix parsing in open-sse/executors/codex.js: the
// requested id carries the reasoning effort, the upstream model never does.
const CODEX_EFFORT_SUFFIXES = ["none", "minimal", "low", "medium", "high", "xhigh"];

/**
 * The plan recorded for a connection, canonicalised, or null when unknown.
 *
 * Same resolution order the account UI uses: an explicit `plan` (which the
 * user can correct by hand) wins over whatever OAuth captured, so a fix in the
 * dashboard takes effect on routing too. `subscriptionType` is the legacy
 * shape older imported connections still carry.
 */
export function resolveConnectionPlan(connection) {
  const plan = connection?.plan
    || connection?.providerSpecificData?.plan
    || connection?.providerSpecificData?.chatgptPlanType
    || connection?.subscriptionType
    || null;
  if (typeof plan !== "string" || !plan.trim()) return null;
  // ChatGPT reports the tier in several shapes ("free", "chatgpt_free",
  // "ChatGPT Free"), and a hand-typed plan is freer still.
  return normalizePlan(plan);
}

/**
 * The upstream model a requested id resolves to, without the effort suffix.
 *
 * `cx/gpt-5.6-terra-high` and `gpt-5.6-terra-review` both reach the upstream
 * as `gpt-5.6-terra`, so both have to compare as that — otherwise a free
 * account is filtered off a model it can actually serve.
 */
function upstreamModelId(model) {
  let id = getModelUpstreamId("cx", String(model));
  for (const level of CODEX_EFFORT_SUFFIXES) {
    if (id.endsWith(`-${level}`)) {
      id = id.slice(0, -(level.length + 1));
      break;
    }
  }
  return id;
}

/**
 * False only when the plan is known to be unable to serve the model.
 *
 * Fail-open by design: an unrecorded plan, an unrecognised one, or a provider
 * with no plan tiers all return true — `normalizePlan` already answers "plus"
 * for anything it cannot place. A wrong skip strands an account that would
 * have worked, which is worse than the 400 this avoids.
 */
export function planCanServeModel(provider, connection, model) {
  if (provider !== "codex" || !model) return true;
  if (resolveConnectionPlan(connection) !== "free") return true;
  return CODEX_FREE_PLAN_MODELS.has(upstreamModelId(model));
}
