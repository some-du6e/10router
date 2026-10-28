// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// An API key whose auth keeps failing (a 401 or 403 that isn't a limit, billing
// block or refusal of one model or operation) is turned off instead of being
// retried every time its model lock expires. Each failure counts only if another
// key behind the same proxy served that model, and wasn't refused on it, since
// this key's previous failure on it (the first: within minWindowMs). Trips at
// minFailures with no success in between, when they were all 401s or (401s or
// 403s) span minModels models, spread over
// minWindowMs if every failure had a peer on the same upstream (base URL, Azure
// endpoint, region, location, account, project), else over
// crossUpstreamWindowMs, since a key on its own server may be refused because
// that server is down. A gap longer than the streak's window starts it over. A
// streak with gaps over minWindowMs trips once the failures since the last such
// gap span the window on their own, or once it has 2 bursts (2+ counted
// failures with no such gap between them) and spans the window. A streak that
// would trip with 403s on fewer models (the key may lack only that model) locks
// that model on the key instead: for oneModelLockMs, doubling on each refusal
// after the lock runs out, up to maxOneModelLockMs, until the key succeeds.
// Such a streak survives gaps up to crossUpstreamWindowMs, and any gap once a
// model is locked.
export const AUTH_DEAD_CONFIG = {
  minFailures: 5,
  minWindowMs: 10 * 60 * 1000,
  crossUpstreamWindowMs: 60 * 60 * 1000,
  minModels: 2,
  oneModelLockMs: 60 * 60 * 1000,
  maxOneModelLockMs: 24 * 60 * 60 * 1000,
};

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
