// Spend limits on the client API keys 10router issues: a USD budget, a model
// allowlist and an expiry date. Pure helpers, shared by the request path, the
// keys API and the dashboard. See docs/API_KEY_BUDGETS.md.

export const MAX_BUDGET_USD = 1_000_000_000;
export const MAX_ALLOWED_MODELS = 500;
export const MAX_MODEL_ID_LENGTH = 300;

const CONTEXT_SUFFIX = /\[(\d+[km])\]$/i;

/** Round to whole micro-dollars so float drift never shows as $1999.9999999. */
function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Spend counted against the budget: lifetime spend minus the last reset's baseline. */
export function spentSinceReset(key) {
  const lifetime = Number(key?.lifetimeSpentUsd ?? key?.spentUsd) || 0;
  const offset = Number(key?.spendOffsetUsd) || 0;
  return Math.max(0, roundUsd(lifetime - offset));
}

/**
 * Where a key stands against its budget.
 * @returns {{ spentUsd: number, budgetUsd: number|null, remainingUsd: number|null, exhausted: boolean }}
 */
export function budgetState(key) {
  const spentUsd = Number(key?.spentUsd) || 0;
  const budgetUsd = typeof key?.budgetUsd === "number" && Number.isFinite(key.budgetUsd) ? key.budgetUsd : null;
  if (budgetUsd === null) return { spentUsd, budgetUsd: null, remainingUsd: null, exhausted: false };
  return {
    spentUsd,
    budgetUsd,
    remainingUsd: Math.max(0, roundUsd(budgetUsd - spentUsd)),
    // At the cap counts as used up: a $0 budget lets nothing through.
    exhausted: spentUsd >= budgetUsd,
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
 * endpoint pings): an active key with no limits, so those calls neither get
 * refused by someone's allowlist nor spend someone's budget.
 */
export function pickInternalKey(keys) {
  const active = (keys || []).filter((k) => k && k.isActive !== false && k.key);
  return (active.find((k) => !keyHasLimits(k)) || active[0])?.key || null;
}

function normalizeModelId(id) {
  if (typeof id !== "string") return "";
  return id.trim().replace(CONTEXT_SUFFIX, "").toLowerCase();
}

function matchesAllowed(requested, allowed) {
  if (allowed.has(requested)) return true;
  // A bare id on the list ("claude-opus-5-5") allows that model from any
  // provider ("cc/claude-opus-5-5"). A provider-prefixed entry allows only that provider.
  const slash = requested.indexOf("/");
  return slash > 0 && allowed.has(requested.slice(slash + 1));
}

/**
 * May a key with this allowlist request this model?
 *
 * Allowed when the model is on the list, when it is an alias whose target is
 * on the list, or when it is a combo whose every member is allowed. A combo
 * named on the list is allowed as a whole.
 *
 * @param {string} requested model id as the client sent it
 * @param {string[]|null} allowedModels null or empty = everything allowed
 * @param {{ aliases?: Record<string, string>, getComboModels?: (name: string) => Promise<string[]|null> }} [lookup]
 */
export async function isModelAllowed(requested, allowedModels, lookup = {}, depth = 0) {
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return true;
  const req = normalizeModelId(requested);
  if (!req) return false;
  const allowed = new Set(allowedModels.map(normalizeModelId).filter(Boolean));
  if (matchesAllowed(req, allowed)) return true;

  const raw = String(requested).trim().replace(CONTEXT_SUFFIX, "");
  const target = lookup.aliases?.[raw];
  if (typeof target === "string" && matchesAllowed(normalizeModelId(target), allowed)) return true;

  // Combos are stored under a bare name. The depth cap stops a combo that
  // (mis)lists itself from looping.
  if (depth < 3 && !raw.includes("/") && lookup.getComboModels) {
    const members = await lookup.getComboModels(raw);
    if (Array.isArray(members) && members.length > 0) {
      for (const member of members) {
        if (!(await isModelAllowed(member, allowedModels, lookup, depth + 1))) return false;
      }
      return true;
    }
  }
  return false;
}

/**
 * Validate the limit fields of a key update. Fields left out are not touched;
 * null clears a limit.
 *
 * @returns {{ data: object, errors: string[] }}
 */
export function parseKeyLimitsInput(body) {
  const data = {};
  const errors = [];
  if (!body || typeof body !== "object") return { data, errors };

  if (body.budgetUsd !== undefined) {
    if (body.budgetUsd === null || body.budgetUsd === "") {
      data.budgetUsd = null;
    } else {
      const n = typeof body.budgetUsd === "string" ? Number(body.budgetUsd.trim()) : body.budgetUsd;
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
    if (body.expiresAt === null || body.expiresAt === "") {
      data.expiresAt = null;
    } else if (typeof body.expiresAt !== "string" && typeof body.expiresAt !== "number") {
      errors.push("expiresAt must be an ISO date string, or null for no expiry");
    } else {
      const at = new Date(body.expiresAt);
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
