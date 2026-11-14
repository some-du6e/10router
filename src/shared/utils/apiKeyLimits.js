// Spend limits on the client API keys 10router issues: a USD budget, a model
// allowlist and an expiry date. Client-safe helpers shared by the keys API and
// the dashboard; allowlist matching lives server-side in
// src/sse/services/keyLimits.js. See docs/API_KEY_BUDGETS.md.

const MAX_BUDGET_USD = 1_000_000_000;
const MAX_ALLOWED_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 300;

/** Round to whole micro-dollars so float drift never shows as $1999.9999999. */
export function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Where a key stands against its budget. `spentUsd` is the key's spend since
 * its last reset; `fraction` is how much of the budget is gone (1 = all of it).
 * @returns {{ spentUsd: number, budgetUsd: number|null, remainingUsd: number|null, exhausted: boolean, fraction: number }}
 */
export function budgetState(key) {
  const spentUsd = Number(key?.spentUsd) || 0;
  const budgetUsd = typeof key?.budgetUsd === "number" && Number.isFinite(key.budgetUsd) ? key.budgetUsd : null;
  if (budgetUsd === null) return { spentUsd, budgetUsd: null, remainingUsd: null, exhausted: false, fraction: 0 };
  return {
    spentUsd,
    budgetUsd,
    remainingUsd: Math.max(0, roundUsd(budgetUsd - spentUsd)),
    // At the cap counts as used up: a $0 budget lets nothing through.
    exhausted: spentUsd >= budgetUsd,
    fraction: budgetUsd > 0 ? spentUsd / budgetUsd : 1,
  };
}

export function isKeyExpired(key, now = Date.now()) {
  if (!key?.expiresAt) return false;
  const at = new Date(key.expiresAt).getTime();
  return Number.isFinite(at) && at <= now;
}

/** Does this key carry any limit at all? A key without one behaves exactly as before limits existed. */
export function keyHasLimits(key) {
  if (!key) return false;
  return (typeof key.budgetUsd === "number" && Number.isFinite(key.budgetUsd))
    || (Array.isArray(key.allowedModels) && key.allowedModels.length > 0)
    || !!key.expiresAt;
}

/**
 * The key the dashboard uses for its own calls through /v1 (model tests,
 * endpoint tests, media examples): an active key with no limits, so those calls
 * neither get refused by someone's allowlist nor spend someone's budget. With
 * every active key limited, the first one that can still be used, then the
 * first active one.
 */
export function pickInternalKey(keys) {
  const active = (keys || []).filter((k) => k && k.isActive !== false && k.key);
  const usable = active.filter((k) => !isKeyExpired(k) && !budgetState(k).exhausted);
  return (active.find((k) => !keyHasLimits(k)) || usable[0] || active[0])?.key || null;
}

/**
 * Validate the limit fields of a key update. Fields left out are not touched;
 * null (or an empty string) clears a limit.
 *
 * @returns {{ data: object, errors: string[] }}
 */
export function parseKeyLimitsInput(body) {
  const data = {};
  const errors = [];
  if (!body || typeof body !== "object") return { data, errors };

  if (body.budgetUsd !== undefined) {
    const raw = typeof body.budgetUsd === "string" ? body.budgetUsd.trim() : body.budgetUsd;
    if (raw === null || raw === "") {
      data.budgetUsd = null;
    } else {
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        errors.push("budgetUsd must be a non-negative number of US dollars, or null for no budget");
      } else if (n > MAX_BUDGET_USD) {
        errors.push(`budgetUsd can be at most ${MAX_BUDGET_USD}`);
      } else {
        data.budgetUsd = roundUsd(n);
      }
    }
  }

  if (body.allowedModels !== undefined) {
    if (body.allowedModels === null) {
      data.allowedModels = null;
    } else if (!Array.isArray(body.allowedModels)) {
      errors.push("allowedModels must be an array of model ids, or null to allow every model");
    } else if (body.allowedModels.some((m) => typeof m !== "string")) {
      errors.push("allowedModels may only contain strings");
    } else {
      const seen = new Set();
      const list = [];
      for (const m of body.allowedModels) {
        const id = m.trim();
        if (!id) continue;
        if (id.length > MAX_MODEL_ID_LENGTH) {
          errors.push(`model id is longer than ${MAX_MODEL_ID_LENGTH} characters`);
          break;
        }
        if (seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        list.push(id);
      }
      if (list.length > MAX_ALLOWED_MODELS) errors.push(`allowedModels can list at most ${MAX_ALLOWED_MODELS} models`);
      // An empty list would refuse every request; pausing the key says that more clearly.
      data.allowedModels = list.length ? list : null;
    }
  }

  if (body.expiresAt !== undefined) {
    const raw = typeof body.expiresAt === "string" ? body.expiresAt.trim() : body.expiresAt;
    if (raw === null || raw === "") {
      data.expiresAt = null;
    } else if (typeof raw !== "string" && typeof raw !== "number") {
      errors.push("expiresAt must be an ISO date string, or null for no expiry");
    } else {
      const at = new Date(raw);
      if (Number.isNaN(at.getTime())) errors.push("expiresAt is not a valid date");
      else data.expiresAt = at.toISOString();
    }
  }

  if (body.resetSpend !== undefined) {
    if (typeof body.resetSpend !== "boolean") errors.push("resetSpend must be true or false");
    else if (body.resetSpend) data.resetSpend = true;
  }

  return { data, errors };
}
