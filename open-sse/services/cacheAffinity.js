/**
 * Prompt-cache affinity: conversation → the key (connection) holding its cache.
 *
 * Upstream prompt caches are per account. When a provider has several keys and
 * a conversation lands on a different one, that key writes the whole prompt to
 * its cache again. For long conversations that rebuild costs several times a
 * normal request and slows the first token. So a conversation that asks for a
 * prompt cache prefers the key that served it last, and waits out a short
 * rate-limit lock on that key rather than moving.
 *
 * Only a hash of the conversation's identity is kept, in memory; never content.
 * Codex (`AFFINITY_PROVIDERS`) has its own opt-in pinning in sessionAffinity.js.
 */

import { createHash } from "node:crypto";
import { CACHE_AFFINITY } from "../config/runtimeConfig.js";
import { AFFINITY_PROVIDERS } from "../config/appConstants.js";
import { ROLE } from "../translator/schema/index.js";
import { resolveClientSessionId } from "../utils/sessionManager.js";

const CACHE_CONTROL = "cache_control";
const LEADING_ROLES = new Set([ROLE.SYSTEM, ROLE.DEVELOPER]);
// Claude Code's first system block carries a per-request hash (cch=…).
const BILLING_HEADER = /^x-anthropic-billing-header:[^\n]*(?:\r?\n)?/i;

// Hashed conversation key → { connectionId, at }. Map order is recency order.
const holders = new Map();

const marked = (part) => !!part && typeof part === "object" && !!part[CACHE_CONTROL];
const anyMarked = (list) => Array.isArray(list) && list.some(marked);

/**
 * Does the request ask for a prompt cache? Anthropic `cache_control` on the
 * request, system, tools or message content, or OpenAI's `prompt_cache_key`.
 */
export function requestUsesPromptCache(body) {
  if (!body || typeof body !== "object") return false;
  if (marked(body) || (typeof body.prompt_cache_key === "string" && body.prompt_cache_key)) return true;
  if (anyMarked(body.system) || anyMarked(body.tools)) return true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((m) => marked(m) || anyMarked(m?.content));
}

// What stays the same on every turn of one conversation: the system prompt and
// the first message, without cache markers (clients move them each turn).
function conversationPrefix(body) {
  const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const lead = [];
  for (const item of items) {
    lead.push(item);
    if (!LEADING_ROLES.has(item?.role)) break;
  }
  if (lead.length === 0 && body.system == null && body.instructions == null) return null;
  const stable = (key, value) => {
    if (key === CACHE_CONTROL) return undefined;
    return typeof value === "string" ? value.replace(BILLING_HEADER, "") : value;
  };
  return JSON.stringify([body.system ?? null, body.instructions ?? null, lead], stable).slice(0, CACHE_AFFINITY.prefixChars);
}

/**
 * Key for a conversation on one provider model, or null when the request gets
 * no affinity (off, Codex, no cache asked for, nothing to identify it by).
 * The client's session id names the conversation when it sends one; otherwise
 * its system prompt and first message do.
 */
export function cacheAffinityKey({ provider, model, body, headers } = {}) {
  if (!CACHE_AFFINITY.ttlMs || !provider || !model || AFFINITY_PROVIDERS.has(provider)) return null;
  if (!requestUsesPromptCache(body)) return null;
  const session = resolveClientSessionId({ headers: headers || {}, body, strict: true });
  const identity = session ? `session:${session}` : conversationPrefix(body);
  if (!identity) return null;
  return createHash("sha256").update(`${provider}\0${model}\0${identity}`).digest("hex").slice(0, 32);
}

/** Connection that served this conversation within the TTL, or null. */
export function getCacheHolder(key) {
  if (!key) return null;
  const entry = holders.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_AFFINITY.ttlMs) {
    holders.delete(key);
    return null;
  }
  return entry.connectionId;
}

/** This connection now serves (and caches) the conversation. */
export function rememberCacheHolder(key, connectionId) {
  if (!key || !connectionId) return;
  holders.delete(key);
  while (holders.size >= CACHE_AFFINITY.maxEntries) holders.delete(holders.keys().next().value);
  holders.set(key, { connectionId, at: Date.now() });
}

export function clearCacheHolders() {
  holders.clear();
}

export function cacheHolderCount() {
  return holders.size;
}

/**
 * How long to wait for the cache holder before using another key, or 0 to go
 * on as usual. `lock` is from getLimitLock: the holder's rate-limit lock on the
 * model (`limitUntilMs`) and whether another key could serve meanwhile
 * (`alternative`). Without one, nothing changes: the usual all-locked path
 * runs. `promptTokens` is called only when the rest would wait.
 * @param {{ lock: { limitUntilMs: number, alternative: boolean } | null, waitedMs?: number, promptTokens: () => number }} args
 * @returns {number}
 */
export function planCacheWait({ lock, waitedMs = 0, promptTokens }) {
  if (!lock?.alternative) return 0;
  const waitMs = (lock.limitUntilMs || 0) - Date.now();
  if (!(waitMs > 0) || waitedMs + waitMs > CACHE_AFFINITY.maxWaitMs) return 0;
  if (!(promptTokens() >= CACHE_AFFINITY.minPromptTokens)) return 0;
  return waitMs + CACHE_AFFINITY.lockSlackMs;
}

/**
 * Resolves after `ms`, or as soon as `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal | null} [signal]
 */
export function waitUnlessAborted(ms, signal = null) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener?.("abort", done, { once: true });
  });
}
