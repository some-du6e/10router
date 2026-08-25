/**
 * Codex session → account affinity.
 *
 * The gateway re-picks an account for every turn. For most providers that is
 * exactly what you want: it spreads load and lets a rate-limited account be
 * dodged mid-conversation. For Codex it is expensive. Codex sends a stable
 * `session_id` and the executor already turns that into a stable
 * `prompt_cache_key` (see `resolveCacheSessionId` in `executors/codex.js`), but
 * the upstream prompt cache is per-account — so a stable key spread across N
 * accounts scores a cache miss on ~21k tokens of system prompt + tool schemas
 * on nearly every turn.
 *
 * This module pins one client session to one connection for as long as the
 * session stays warm, which is what makes that cache key actually pay off. It
 * is the same idea codex-lb calls `sticky_kind=codex_session`.
 *
 * Deliberately narrow:
 *   - only providers in `AFFINITY_PROVIDERS` are considered, so every other
 *     format/provider keeps the existing per-turn selection untouched;
 *   - a pin is a *preference*, never a requirement. `getProviderCredentials`
 *     ignores a `preferredConnectionId` that is rate-limited, model-locked or
 *     excluded, and falls back to the configured strategy. Callers release the
 *     pin when they fall away from it so the session rebinds instead of
 *     retrying a dead account forever.
 *
 * Storage follows the TTL/eviction shape already used by `utils/sessionManager.js`.
 */

import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { AFFINITY_PROVIDERS } from "../config/appConstants.js";
import { resolveClientSessionId } from "../utils/sessionManager.js";

// Key = `${provider}:${sessionId}[#threadId]`, Value = { connectionId, lastUsed }
const affinityStore = new Map();

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of affinityStore) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) affinityStore.delete(key);
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (cleanupInterval.unref) cleanupInterval.unref();

export function isAffinityProvider(provider) {
  return AFFINITY_PROVIDERS.has(provider);
}

// Accept a `Headers` instance or an already-plain object; downstream lookups
// index by lowercase name.
function toPlainHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function" && typeof headers.get === "function") {
    return Object.fromEntries(headers.entries());
  }
  if (typeof headers !== "object") return {};
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[String(name).toLowerCase()] = value;
  return out;
}

function normalize(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > 256) return null;
  return v;
}

/**
 * Build the affinity key for a request, or null when this request should keep
 * the default per-turn selection.
 *
 * The session id comes from the same resolver the prompt-cache key uses, so a
 * pinned session and its cache key always agree on what "the session" is. Only
 * client-supplied identity counts: the resolver's connection-derived fallback
 * would be circular here (it is derived *from* the account we are choosing).
 *
 * Codex also sends a `thread-id` for conversations inside one CLI process.
 * Two threads of the same process are separate conversations with separate
 * upstream caches, so they get separate pins — mirroring codex-lb's
 * (process, thread) identity in `modules/proxy/affinity.py`.
 */
export function affinityKeyFor({ provider, headers, body } = {}) {
  if (!isAffinityProvider(provider)) return null;
  const plain = toPlainHeaders(headers);
  const session = resolveClientSessionId({ headers: plain, body, scope: "codex" });
  if (!session) return null;
  const thread = normalize(plain["thread-id"]);
  return `${provider}:${session}${thread ? `#${thread}` : ""}`;
}

/** Connection this session is currently pinned to, or null. */
export function getAffinity(key) {
  if (!key) return null;
  const entry = affinityStore.get(key);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.connectionId;
}

/** Pin (or re-pin) a session to a connection. */
export function bindAffinity(key, connectionId) {
  if (!key || !connectionId) return;
  const entry = affinityStore.get(key);
  if (entry) {
    entry.connectionId = connectionId;
    entry.lastUsed = Date.now();
    return;
  }
  // Safety cap between cleanup cycles: evict the oldest insertion.
  if (affinityStore.size >= MEMORY_CONFIG.maxAffinitySessions) {
    affinityStore.delete(affinityStore.keys().next().value);
  }
  affinityStore.set(key, { connectionId, lastUsed: Date.now() });
}

/**
 * Drop a pin that just failed. Guarded on the connection id so a concurrent
 * turn that already rebound the session to a healthy account is not undone.
 */
export function releaseAffinity(key, connectionId) {
  if (!key) return;
  const entry = affinityStore.get(key);
  if (!entry) return;
  if (connectionId && entry.connectionId !== connectionId) return;
  affinityStore.delete(key);
}

/** Test/reset hook. */
export function clearAffinityStore() {
  affinityStore.clear();
}
