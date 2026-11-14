// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  CLIENT_CLOSED_REQUEST: 499,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";
// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
  maxAffinitySessions: 5000,
};

// Largest delay setTimeout honours; above it the timer fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Parse an integer env override (min..MAX_TIMER_MS), falling back to a default.
function envMs(name, def, min = 1) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= MAX_TIMER_MS ? n : def;
}

// Parse a plain non-negative decimal integer env override (min..max), else the
// default. Unlike envMs, "5m", "1e4" or "0x10" are rejected, not misread.
function envInt(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return def;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Must resolve to a public address; fetchPublic blocks localhost and private hosts.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");
export const SEARXNG_CONFIGURED = Boolean(envUrl("SEARXNG_URL", ""));

// Prompt-cache affinity (services/cacheAffinity.js): a conversation that asks for
// a prompt cache prefers the keys (accounts) that served it recently, because
// the upstream cache is per account.
export const CACHE_AFFINITY = {
  // How long after a key last served a conversation it counts as warm for it:
  // the upstream 5-minute prompt cache TTL. 0 turns cache affinity off.
  // Env: CACHE_AFFINITY_TTL_MS.
  ttlMs: envInt("CACHE_AFFINITY_TTL_MS", 5 * 60 * 1000),
  // Used instead when the request's cache_control asks for ttl: "1h".
  longTtlMs: 60 * 60 * 1000,
  // Longest one request waits, in all per model it tries, for a warm key's
  // rate-limit lock to clear instead of moving to a cold key. 0: never wait.
  // Env: CACHE_AFFINITY_MAX_WAIT_MS.
  maxWaitMs: envInt("CACHE_AFFINITY_MAX_WAIT_MS", 10 * 1000, { max: MAX_TIMER_MS }),
  // Only a request at least this big (estimated prompt tokens) waits; a smaller
  // one rebuilds its cache cheaply on another key. Env: CACHE_AFFINITY_MIN_TOKENS.
  minPromptTokens: envInt("CACHE_AFFINITY_MIN_TOKENS", 32 * 1000),
  // Conversations remembered at once; the least recently used goes first.
  maxEntries: 10 * 1000,
  // Warm keys remembered per conversation; the least recently used goes first.
  maxWarmKeys: 4,
  // Added to a wait so the lock has surely ended when the request retries.
  lockSlackMs: 25,
  // Up to this much more, at random, so requests waiting on one key don't all
  // retry it at once and escalate its backoff.
  jitterMs: 250,
};

// Soft demotion (sse/services/auth.js): an API key whose demotion count on a
// model would demote it in minWindowMs, but needs crossUpstreamWindowMs because
// a peer on another upstream served, goes after the other keys there, with
// tries on AUTH_DEMOTE_CONFIG's probe schedule, until it serves that model;
// meanwhile its refusals there don't count toward demoting it, the ones before
// it are forgotten as a success would, and nothing turns the key off. Stored on the
// connection (authSoft_<model>). Env: AUTH_SOFT_DEMOTE=0 turns it off;
// anything else leaves it on.
export const AUTH_SOFT_DEMOTE = {
  enabled: envInt("AUTH_SOFT_DEMOTE", 1, { max: 1 }) !== 0,
};

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Write an SSE comment to the client after this long without output, so proxies
// that drop idle connections (Cloudflare cuts at ~100s) keep the stream open.
// Env: STREAM_KEEPALIVE_MS (0 disables).
export const STREAM_KEEPALIVE_MS = envMs("STREAM_KEEPALIVE_MS", 15 * 1000, 0);

// Opt-in: a key with a spend budget whose client hangs up mid-stream keeps
// reading the upstream (discarding it) until the final usage arrives, for at
// most this long, so the key is charged what the provider reports. Off by
// default: every Esc would otherwise run the whole generation upstream.
// Env: STREAM_DRAIN_MAX_MS (0, the default, disables the drain).
export const STREAM_DRAIN_MAX_MS = envMs("STREAM_DRAIN_MAX_MS", 0, 0);

// A stream cut short before its final usage is charged at least this many
// output tokens per second it ran: hidden thinking streams nothing visible,
// so the visible text alone would make an early Esc nearly free.
// Env: STREAM_ABORT_FLOOR_TPS (0 disables the floor).
export const STREAM_ABORT_FLOOR_TPS = envMs("STREAM_ABORT_FLOOR_TPS", 150, 0);

// A streaming request whose upstream hasn't sent response headers after this
// long gets 200 + SSE headers and keepalives, so a proxy that waits ~100s for
// headers (Cloudflare 524) doesn't drop it. Fallback continues server-side; a
// final failure is then written into the stream.
// Env: STREAM_EARLY_HEADERS_MS (0 disables; so does STREAM_KEEPALIVE_MS=0).
export const STREAM_EARLY_HEADERS_MS = envMs("STREAM_EARLY_HEADERS_MS", 30 * 1000, 0);

// The same for a non-streaming request (/v1/messages, /v1/chat/completions,
// /v1/responses): 200 + JSON content type, a whitespace byte every
// STREAM_KEEPALIVE_MS, then the JSON body, or the failure as the client's error
// body. Defaults to STREAM_EARLY_HEADERS_MS, so while this is unset that
// switch turns both off.
// Env: NON_STREAM_EARLY_HEADERS_MS (0 disables only this; so does STREAM_KEEPALIVE_MS=0).
export const NON_STREAM_EARLY_HEADERS_MS = envMs("NON_STREAM_EARLY_HEADERS_MS", STREAM_EARLY_HEADERS_MS, 0);

// Wait for a Chat Completions usage trailer before completing a Responses stream.
export const RESPONSES_COMPLETION_WAIT_MS = 3000;

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
