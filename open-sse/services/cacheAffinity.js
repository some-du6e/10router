/**
 * Prompt-cache affinity: conversation → the keys (connections) that hold its cache.
 *
 * Upstream prompt caches are per account. When a provider has several keys and
 * a conversation lands on one that hasn't served it recently, that key writes
 * the whole prompt to its cache again. For long conversations that rebuild
 * costs several times a normal request and slows the first token. So each
 * conversation that asks for a prompt cache remembers its warm keys (the ones
 * that served it within the cache TTL). Account selection takes one when the
 * strategy ranks it with its own pick (see getProviderCredentials), and a big
 * request waits out a short rate-limit lock on such a key rather than moving to
 * a cold one.
 *
 * Only a hash of the conversation's identity is kept, in memory; never content.
 * Codex (`AFFINITY_PROVIDERS`) has its own opt-in pinning in sessionAffinity.js.
 */

import { createHash } from "node:crypto";
import { CACHE_AFFINITY } from "../config/runtimeConfig.js";
import { AFFINITY_PROVIDERS, INLINE_MEDIA } from "../config/appConstants.js";
import { ROLE, OPENAI_BLOCK } from "../translator/schema/index.js";
import { resolveClientSessionId } from "../utils/sessionManager.js";
import { stripAnthropicBillingHeader } from "../utils/claudeCloaking.js";

const CACHE_CONTROL = "cache_control";
const LONG_TTL = "1h";
const LEADING_ROLES = new Set([ROLE.SYSTEM, ROLE.DEVELOPER]);
const INPUT_AUDIO = OPENAI_BLOCK.INPUT_AUDIO;

// Hashed conversation key → Map(connectionId → { at, ttlMs }). Map order is
// recency order at both levels.
const conversations = new Map();

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Every cache_control marker on the request, system, tools or message content.
function cacheMarkers(body) {
  const markers = [];
  const take = (part) => {
    if (part && typeof part === "object" && part[CACHE_CONTROL]) markers.push(part[CACHE_CONTROL]);
  };
  const takeAll = (list) => Array.isArray(list) && list.forEach(take);
  take(body);
  takeAll(body.system);
  takeAll(body.tools);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    take(m);
    takeAll(m?.content);
  }
  return markers;
}

/**
 * Does the request ask for a prompt cache? Anthropic `cache_control` on the
 * request, system, tools or message content, or OpenAI's `prompt_cache_key`.
 */
export function requestUsesPromptCache(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key) return true;
  return cacheMarkers(body).length > 0;
}

/** How long a key stays warm after serving this request: 1h when a marker asks for it. */
export function cacheTtlMs(body) {
  const long = body && typeof body === "object" && cacheMarkers(body).some((m) => m?.ttl === LONG_TTL);
  return long ? Math.max(CACHE_AFFINITY.longTtlMs, CACHE_AFFINITY.ttlMs) : CACHE_AFFINITY.ttlMs;
}

// What stays the same on every turn of one conversation: the system prompt,
// instructions and the first message, without cache markers (clients move them
// each turn) or Claude Code's per-request billing header.
function conversationStart(body) {
  const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const lead = [];
  for (const item of items) {
    lead.push(item);
    if (!LEADING_ROLES.has(item?.role)) break;
  }
  if (lead.length === 0 && body.system == null && body.instructions == null) return null;
  const stable = (key, value) => {
    if (key === CACHE_CONTROL) return undefined;
    return typeof value === "string" ? stripAnthropicBillingHeader(value) : value;
  };
  return JSON.stringify([body.system ?? null, body.instructions ?? null, lead], stable);
}

/**
 * Key for a conversation on one provider model, or null when the request gets
 * no affinity (off, Codex, no cache asked for, nothing to identify it by).
 * The conversation's start always names it, so a client session's subagents
 * and side requests (other system prompts, other caches) get keys of their
 * own; the client's session id and `tenant` (the client's API key) are mixed in
 * so separate sessions and tenants never share an entry.
 */
export function cacheAffinityKey({ provider, model, body, headers, tenant } = {}) {
  if (!CACHE_AFFINITY.ttlMs || !provider || !model || AFFINITY_PROVIDERS.has(provider)) return null;
  if (!requestUsesPromptCache(body)) return null;
  const start = conversationStart(body);
  if (!start) return null;
  const session = resolveClientSessionId({ headers: headers || {}, body, strict: true }) || "";
  const tenantPart = typeof tenant === "string" && tenant ? sha256(tenant) : "";
  return sha256([provider, model, tenantPart, session, sha256(start)].join("\0")).slice(0, 32);
}

/** Keys that served this conversation within their TTL, most recent last. */
export function getWarmKeys(key) {
  const warm = key ? conversations.get(key) : null;
  if (!warm) return [];
  const now = Date.now();
  for (const [connectionId, entry] of warm) {
    if (now - entry.at > entry.ttlMs) warm.delete(connectionId);
  }
  if (warm.size === 0) conversations.delete(key);
  return [...warm.keys()];
}

/** This connection just served (and cached) the conversation. */
export function rememberWarmKey(key, connectionId, ttlMs = CACHE_AFFINITY.ttlMs) {
  if (!key || !connectionId || !(ttlMs > 0)) return;
  const warm = conversations.get(key) || new Map();
  conversations.delete(key);
  warm.delete(connectionId);
  warm.set(connectionId, { at: Date.now(), ttlMs });
  while (warm.size > CACHE_AFFINITY.maxWarmKeys) warm.delete(warm.keys().next().value);
  while (conversations.size >= CACHE_AFFINITY.maxEntries) conversations.delete(conversations.keys().next().value);
  conversations.set(key, warm);
}

export function clearCacheAffinity() {
  conversations.clear();
}

export function conversationCount() {
  return conversations.size;
}

// Characters of text in a value, skipping inline binary: data URIs and the
// `data` of a base64 source, inline blob (Anthropic, Gemini) or OpenAI
// `input_audio` part.
function textChars(value, depth = 0, parentKey = "") {
  if (typeof value === "string") return value.startsWith(INLINE_MEDIA.dataUriPrefix) ? 0 : value.length;
  if (!value || typeof value !== "object" || depth > 64) return 0;
  let n = 0;
  if (Array.isArray(value)) {
    for (const v of value) n += textChars(v, depth + 1);
    return n;
  }
  const binary = value.type === INLINE_MEDIA.base64SourceType
    || INLINE_MEDIA.mimeTypeKeys.some((key) => key in value) || parentKey === INPUT_AUDIO;
  for (const [k, v] of Object.entries(value)) {
    if (binary && k === INLINE_MEDIA.dataKey) continue;
    n += k.length + textChars(v, depth + 1, k);
  }
  return n;
}

/** Rough prompt size in tokens (~4 characters each), images and files not counted. */
export function estimatePromptTokens(body) {
  return Math.ceil(textChars(body) / 4);
}

/**
 * How much longer this request may wait for a warm key, or 0 when it may not:
 * a small request rebuilds its cache cheaply elsewhere. `promptTokens` is
 * called only when there is time left to wait.
 * @param {{ waitedMs?: number, promptTokens: () => number }} args
 * @returns {number}
 */
export function warmWaitBudget({ waitedMs = 0, promptTokens }) {
  const left = CACHE_AFFINITY.maxWaitMs - waitedMs;
  if (!(left > 0)) return 0;
  return promptTokens() >= CACHE_AFFINITY.minPromptTokens ? left : 0;
}

/**
 * Random extra delay, 0..CACHE_AFFINITY.jitterMs, so requests waiting on one
 * key don't all retry it at once.
 * @param {() => number} [random]
 * @returns {number}
 */
export function warmJitterMs(random = Math.random) {
  return Math.floor(Math.min(Math.max(random(), 0), 0.999) * (CACHE_AFFINITY.jitterMs + 1));
}

/**
 * When to retry a warm key locked until `lockEndMs`: just after the lock
 * (slack + jitter), but no later than `budgetMs` from now. Null when even the
 * lock plus its slack doesn't fit the budget. Keeps a request's waits within
 * CACHE_AFFINITY.maxWaitMs in all.
 * @param {number} lockEndMs
 * @param {number} budgetMs
 * @param {number} [jitterMs]
 * @returns {number | null}
 */
export function warmRetryAt(lockEndMs, budgetMs, jitterMs = 0) {
  const now = Date.now();
  const earliest = Math.max(lockEndMs, now) + CACHE_AFFINITY.lockSlackMs;
  if (earliest - now > budgetMs) return null;
  return Math.min(earliest + jitterMs, now + budgetMs);
}
