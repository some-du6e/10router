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
// 403s) span minModels models (a 403 on one model can be a plan limit), spread over
// minWindowMs if every failure had a peer on the same upstream (base URL, Azure
// endpoint, region, location, account, project), else over
// crossUpstreamWindowMs, since a key on its own server may be refused because
// that server is down. A gap longer than the streak's window starts it over. A
// streak with gaps over minWindowMs trips once the failures since the last such
// gap span the window on their own, or once it has 2 bursts (2+ counted
// failures with no such gap between them) and spans the window.
export const AUTH_DEAD_CONFIG = {
  minFailures: 5,
  minWindowMs: 10 * 60 * 1000,
  crossUpstreamWindowMs: 60 * 60 * 1000,
  minModels: 2,
};

// An API key refused with 403s on one model, which may be all it lacks, is
// demoted on that model instead: other keys are tried first. It counts the
// 403s AUTH_DEAD_CONFIG would count, and 403s refusing just that model, on that
// model alone: minFailures of them spanning minWindowMs (crossUpstreamWindowMs
// if any had only a peer on another upstream), a gap over crossUpstreamWindowMs
// starting the count over, and only a success on that model clearing it. A
// demoted key still gets one request probeMs[0] after demotion, and each refused
// probe waits for the next of probeMs (the last repeating); a probe left
// unanswered is retaken after probeLeaseMs. A success brings the key back.
export const AUTH_DEMOTE_CONFIG = {
  probeMs: [10, 20, 40, 90, 180].map(min => min * 60 * 1000),
  probeLeaseMs: 10 * 60 * 1000,
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

// Failure buckets recorded on requestDetails rows (errorClass) so failures can be
// told apart from the DB without parsing provider error text.
export const ERROR_CLASS = {
  AUTH_ERROR: "auth_error",
  RATE_LIMITED: "rate_limited",
  UPSTREAM_5XX: "upstream_5xx",
  TIMEOUT: "timeout",
  NETWORK_ERROR: "network_error",
  CLIENT_ERROR: "client_error",
  ABORTED: "aborted",
  OTHER: "other",
};

// Limit, billing and plan refusals isLimitError doesn't know ("Key limit
// exceeded (daily limit)", qoder's "Queue limit" or "Upgrade required" with a
// pricingUrl, "credits exhausted", "account balance is insufficient",
// AccountOverdueError), refusals of one model ("does not have access to model
// 'o3'") and of one operation by a restricted key ("Missing scopes: ...").
export const LIMIT_REFUSAL = [
  /\blimit|queue|upgrade|pricing|\bplans?\b|credit|quota|exhausted|usage cap|billing|budget|payment/,
  /\bbalance\b|\bfunds\b|overdue|arrears|unpaid|recharge|top[- ]?up/,
];
export const MODEL_REFUSAL = /does not have access to (?:the )?model|model_not_found|\bmodel\b.{0,60}?\bnot (?:available|allowed|enabled|permitted|supported)\b/i;
export const OPERATION_REFUSAL = /insufficient (?:permissions?|scopes?|privileges?)|missing (?:required )?(?:scopes?|permissions?)|permission denied for this operation|not (?:allowed|permitted|authorized) to perform this operation/;

// Account errors some upstreams send as 400: a bad key (Gemini: "API key not
// valid", API_KEY_INVALID) or no money left (Anthropic: "Your credit balance is
// too low"; Cursor usage limits).
export const BAD_KEY_TEXTS = ["api key not valid", "api_key_invalid", "invalid api key", "invalid_api_key", "invalid x-api-key"];
export const BILLING_TEXTS = [
  "credit balance", "insufficient_quota", "insufficient balance", "billing_hard_limit_reached",
  "billing account", "billing details", "usage limit reached", "usage limit exceeded",
];

// Error text (lowercased) meaning the upstream didn't answer in time. Whole words
// only: "stall" must not match "install", and a 400 about a bad `timeout`
// parameter is not a timeout. Covers undici cause codes, trae's "trae stream
// timeout" and AbortSignal.timeout's "The operation was aborted due to timeout".
export const TIMEOUT_PATTERN = /\b(timed out|etimedout|und_err_(connect|headers|body)_timeout|(connect|headers|read|request|stream) timeout|aborted due to timeout|stalled?)\b/;
// Error text (lowercased, cause code included) of a fetch that never reached the upstream.
export const NETWORK_PATTERN = /\b(enotfound|econnrefused|econnreset|econnaborted|ehostunreach|enetunreach|eai_again|epipe|und_err_socket|socket hang up|other side closed|fetch failed)\b/;
// Only this much of an error message is classified; bodies can be megabytes.
export const ERROR_CLASS_MAX_TEXT = 8 * 1024;
