import { randomUUID } from "node:crypto";
import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { extractClientApiKey } from "@/shared/utils/clientApiKey.js";
import { AUTH_DEMOTE_PREFIX, getAuthDemoteKey } from "@/lib/db/index.js";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, getQuotaCooldown, isModelLockActive, getModelLockUntil, buildModelLockUpdate, getEarliestModelLockUntil, getModelLockKey, MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, AUTH_DEAD_CONFIG, AUTH_DEMOTE_CONFIG, LIMIT_REFUSAL, MODEL_REFUSAL, OPERATION_REFUSAL } from "open-sse/config/errorConfig.js";
import { isBackoffText } from "open-sse/utils/errorClass.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { planCanServeModel } from "@/shared/utils/planCapability.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { getRoutingQuotas, getResetState, pickSoonestReset } from "./soonestReset.js";
import * as log from "../utils/logger.js";
import { getNextAccountReset, PROVIDER_RESET_PREFIX, extractProviderMessage } from "./accountFailureSummary.js";
import { isLimitError } from "open-sse/utils/limitHold.js";
import { warmJitterMs, warmRetryAt } from "open-sse/services/cacheAffinity.js";

// Per-provider mutexes for account selection. Picks for the same provider stay
// serialized (round-robin sticky counters read-then-write lastUsedAt and
// consecutiveUseCount); picks for different providers touch disjoint state and
// run concurrently. Kept on global so duplicated Next.js module instances share it.
const selectionMutexes = (global._selectionMutexes ??= new Map());
const MODEL_LIMIT_PREFIX = "modelLimit_";

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

const AUTH_FAIL_CLEARED = {
  authFailCount: null, authFailFirstAt: null, authFailLastAt: null, authFailModels: null, authFailAll401: null,
  authFailSameUpstream: null, authFailRunCount: null, authFailRunStartAt: null, authFailBursts: null,
};
const MAX_TRACKED_MODELS = 5;
const REASON_MAX_CHARS = 80;
const MAX_EVENT_ENTRIES = 5000;

// Last success per connection and per `${connectionId}|${model}`, and last auth
// refusal per `${connectionId}|${model}`, as { at, seq }; seq orders events in
// the same millisecond. Memory only, so the success path never writes the DB;
// after a restart it is empty and keys just take longer to trip.
const authEvents = (global._authEvents ??= { seq: 0, success: new Map(), refused: new Map() });
// Refusals of one model by a key (isModelRefusal), apart from `refused` so the
// turn-off rule's evidence is untouched by them; the keys this process wrote a
// demotion record for; and the keys it has seen succeed.
authEvents.modelRefused ??= new Map();
authEvents.demoteKeys ??= new Set();
authEvents.servedKeys ??= new Set();

function remember(map, key) {
  const now = Date.now();
  if (map.size >= MAX_EVENT_ENTRIES) {
    for (const [k, e] of map) if (now - e.at > AUTH_DEAD_CONFIG.minWindowMs) map.delete(k);
    if (map.size >= MAX_EVENT_ENTRIES) map.clear();
  }
  map.set(key, { at: now, seq: ++authEvents.seq });
}

function recordSuccess(connectionId, model) {
  remember(authEvents.success, connectionId);
  if (model) remember(authEvents.success, `${connectionId}|${model}`);
}

const succeededSince = (key, sinceMs) => (authEvents.success.get(key)?.at ?? -Infinity) >= sinceMs;

// LIMIT_REFUSAL, MODEL_REFUSAL, OPERATION_REFUSAL: a limit or a refusal of one
// model or operation; the key itself is fine.
const anyOf = (patterns) => new RegExp(patterns.map(r => r.source).join("|"), "i");
const NOT_KEY_REFUSAL = anyOf([...LIMIT_REFUSAL, MODEL_REFUSAL, OPERATION_REFUSAL]);
const NOT_MODEL_REFUSAL = anyOf([...LIMIT_REFUSAL, OPERATION_REFUSAL]);

// A 401 or 403 that is not a limit or a refusal of one model: the key itself is refused.
function isAuthRejection(status, errorText) {
  const code = Number(status);
  const text = String(errorText || "");
  return (code === 401 || code === 403) && !isLimitError(code, errorText) && !NOT_KEY_REFUSAL.test(text) && !isBackoffText(text);
}

// A 403 saying this key may not use the model, and not a limit: the key lacks
// just that model. Never turns a key off; it can demote it there.
function isModelRefusal(status, errorText) {
  const text = String(errorText || "");
  return Number(status) === 403 && !isLimitError(403, errorText) && MODEL_REFUSAL.test(text) && !NOT_MODEL_REFUSAL.test(text)
    && !isBackoffText(text);
}

// Per-connection fields executors build the upstream URL from: a custom base
// URL, an Azure resource, a region or location in the host, an account or
// project in the path.
const UPSTREAM_FIELDS = ["baseUrl", "azureEndpoint", "region", "location", "accountId", "projectId"];

// Where a key's requests go: the proxy or relay they leave through, and the
// upstream they reach.
async function networkPath(conn) {
  const psd = conn.providerSpecificData || {};
  const p = await resolveConnectionProxyConfig(psd);
  const proxy = p.connectionProxyEnabled && p.connectionProxyUrl ? p.connectionProxyUrl : "";
  return {
    transport: JSON.stringify([proxy, proxy ? p.connectionNoProxy || "" : "", p.vercelRelayUrl || ""]),
    upstream: JSON.stringify(UPSTREAM_FIELDS.map(f => String(psd[f] ?? "").trim().replace(/\/+$/, ""))),
  };
}

// Only API keys count: an OAuth token or session cookie that fails to refresh
// gets 401s while its peers' tokens work, and that isn't a dead account.
// The refusal counts when another key of the provider, behind the same proxy or
// relay, served this model and was not refused on it since this key's previous
// refusal of it (for the first one, within minWindowMs): a failure every key
// sees, always or only some of the time (region block, proxy page, auth
// outage), is not this key's. Returns "same-upstream" when such a peer also
// reaches the same upstream, "other-upstream" when only peers on another base
// URL, account or region do (this key's own server may be the one down), or
// null. Web search/fetch lock keys ("websearch:x") are not models; ids like
// "x:free" are. Demotion also asks for isModelRefusal ones (`counts`), kept in
// their own memory (`refusals`).
async function authFailEvidence(connections, conn, model, status, errorText, counts = isAuthRejection, refusals = authEvents.refused) {
  if (!model || /^web(search|fetch):/.test(model) || !counts(status, errorText)) return null;
  const previous = refusals.get(`${conn.id}|${model}`);
  remember(refusals, `${conn.id}|${model}`);
  if (conn.authType !== "apikey") return null;
  const since = Date.now() - AUTH_DEAD_CONFIG.minWindowMs;
  const after = (event) => event && (previous ? event.seq > previous.seq : event.at >= since);
  const refusedAfter = (id) => after(authEvents.refused.get(`${id}|${model}`)) || after(refusals.get(`${id}|${model}`));
  const peers = connections.filter(c => c.id !== conn.id
    && after(authEvents.success.get(`${c.id}|${model}`)) && !refusedAfter(c.id));
  if (peers.length === 0) return null;
  const own = await networkPath(conn);
  let evidence = null;
  for (const peer of peers) {
    const path = await networkPath(peer);
    if (path.transport !== own.transport) continue;
    if (path.upstream === own.upstream) return "same-upstream";
    evidence = "other-upstream";
  }
  return evidence;
}

function nextAuthFailStreak(conn, model, status, sameUpstream) {
  const now = Date.now();
  const firstAt = new Date(conn.authFailFirstAt || NaN).getTime();
  const sinceLast = now - new Date(conn.authFailLastAt || conn.authFailFirstAt || NaN).getTime();
  // Starts over when the last counted failure is older than the window the
  // streak needs (a backup key left with an outage's leftovers; a streak that
  // needs an hour survives the idle gaps of someone pausing for 10+ minutes),
  // when this key succeeded after the streak began on a request whose snapshot
  // predates it, or when a timestamp is unreadable or in the future (the
  // negated range check is also false for NaN).
  const maxGapMs = conn.authFailSameUpstream === true ? AUTH_DEAD_CONFIG.minWindowMs : AUTH_DEAD_CONFIG.crossUpstreamWindowMs;
  const fresh = !(now - firstAt >= 0)
    || !(sinceLast >= 0 && sinceLast <= maxGapMs)
    || succeededSince(conn.id, firstAt + 1);
  const models = !fresh && Array.isArray(conn.authFailModels) ? conn.authFailModels : [];
  // A run is the counted failures since the last gap over minWindowMs; a burst
  // is a run of 2 or more.
  const run = fresh || sinceLast > AUTH_DEAD_CONFIG.minWindowMs ? 1 : (conn.authFailRunCount ?? conn.authFailCount ?? 0) + 1;
  const bursts = fresh ? 0 : conn.authFailBursts ?? ((conn.authFailCount || 0) >= 2 ? 1 : 0);
  return {
    authFailCount: (fresh ? 0 : conn.authFailCount || 0) + 1,
    authFailRunCount: run,
    // A streak saved before runs had a start: the run is the whole streak only
    // if it has no gap in it; otherwise start the run at its last failure.
    authFailRunStartAt: run === 1 ? new Date(now).toISOString() : conn.authFailRunStartAt
      || (conn.authFailRunCount == null || conn.authFailRunCount === conn.authFailCount ? conn.authFailFirstAt : conn.authFailLastAt),
    authFailBursts: bursts + (run === 2 ? 1 : 0),
    authFailFirstAt: fresh ? new Date(now).toISOString() : conn.authFailFirstAt,
    authFailLastAt: new Date(now).toISOString(),
    authFailModels: models.includes(model) ? models : [...models, model].slice(-MAX_TRACKED_MODELS),
    authFailAll401: Number(status) === 401 && (fresh || conn.authFailAll401 === true),
    authFailSameUpstream: sameUpstream && (fresh || conn.authFailSameUpstream === true),
  };
}

// Trips once the current run alone has minFailures over the window, or once
// the streak has 2 bursts and spans the window: a few refusals spread thinly
// over an hour, or one burst followed by them, can't trip it.
function isAuthDead(streak) {
  const windowMs = streak.authFailSameUpstream ? AUTH_DEAD_CONFIG.minWindowMs : AUTH_DEAD_CONFIG.crossUpstreamWindowMs;
  const spans = (at) => Date.now() - new Date(at).getTime() >= windowMs;
  const runAlone = streak.authFailRunCount >= AUTH_DEAD_CONFIG.minFailures && spans(streak.authFailRunStartAt);
  const bursts = streak.authFailBursts >= 2 && spans(streak.authFailFirstAt);
  return streak.authFailCount >= AUTH_DEAD_CONFIG.minFailures && (runAlone || bursts)
    && (streak.authFailAll401 || streak.authFailModels.length >= AUTH_DEAD_CONFIG.minModels);
}

function refusalText(status, errorText) {
  const text = String(extractProviderMessage(errorText)).replace(/^\[\d+\]:\s*/, "").replace(/\s+/g, " ").trim();
  const message = text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS - 1)}…` : text;
  return `${status}${message ? ` "${message}"` : ""}`;
}

function autoDisableReason(status, errorText, streak) {
  return `${refusalText(status, errorText)} on ${streak.authFailModels.join(", ")}`;
}

const probeMs = (level) => AUTH_DEMOTE_CONFIG.probeMs[Math.min(level, AUTH_DEMOTE_CONFIG.probeMs.length - 1)];

// A key's demotion record for a model after one more counted 403 on it at
// nowMs (see AUTH_DEMOTE_CONFIG); lastCountedAt is its last refusal the turn-off
// rule counts too. It doesn't trip while the key was refused, in a way that rule
// counts, on another model (lastly at otherRefusalAt) within the window: that
// rule decides then. A new count keeps the key's last success before it
// (lastServedAt) as servedAt. A demoted record counts on and moves its next
// probe out, keeping the lease of the probe just answered.
function nextDemoteRecord(record, nowMs, { sameUpstream, otherRefusalAt = -Infinity, modelScoped = false, lastServedAt, reason }) {
  const now = new Date(nowMs).toISOString();
  const lastCountedAt = modelScoped ? record?.lastCountedAt : now;
  if (record?.demotedAt) {
    const probeLevel = (record.probeLevel || 0) + 1;
    const nextProbeAt = new Date(nowMs + probeMs(probeLevel)).toISOString();
    return { ...record, count: record.count + 1, lastAt: now, lastCountedAt, probeLevel, nextProbeAt };
  }
  const sinceLast = nowMs - new Date(record?.lastAt).getTime();
  const restart = !(sinceLast >= 0 && sinceLast <= AUTH_DEAD_CONFIG.crossUpstreamWindowMs);
  const count = (restart ? 0 : record.count) + 1;
  const firstAt = restart ? now : record.firstAt;
  const allSameUpstream = sameUpstream && (restart || record.sameUpstream === true);
  const windowMs = allSameUpstream ? AUTH_DEAD_CONFIG.minWindowMs : AUTH_DEAD_CONFIG.crossUpstreamWindowMs;
  const servedAt = restart ? (Number.isFinite(lastServedAt) ? new Date(lastServedAt).toISOString() : undefined) : record.servedAt;
  const next = {
    count, firstAt, lastAt: now, lastCountedAt, servedAt,
    sameUpstream: allSameUpstream, modelScoped: modelScoped || (!restart && record.modelScoped === true),
  };
  const enough = count >= AUTH_DEAD_CONFIG.minFailures && nowMs - new Date(firstAt).getTime() >= windowMs;
  const refusedElsewhere = nowMs - otherRefusalAt <= windowMs;
  if (!enough || refusedElsewhere) return next;
  return { ...next, demotedAt: now, reason, probeLevel: 0, nextProbeAt: new Date(nowMs + probeMs(0)).toISOString() };
}

export const __test__ = { nextDemoteRecord };

// The key's demotion records, [model, record], skipping any a success on that
// model since the count began has lifted (one whose write the success's
// snapshot was too old to make).
const demoteRecords = (conn) => Object.entries(conn)
  .filter(([k, r]) => k.startsWith(AUTH_DEMOTE_PREFIX) && r)
  .map(([k, r]) => [k.slice(AUTH_DEMOTE_PREFIX.length), r])
  .filter(([m, r]) => !succeededSince(`${conn.id}|${m}`, new Date(r.firstAt).getTime()));

const demotionOf = (conn, model) => {
  const record = model ? demoteRecords(conn).find(([m]) => m === model)?.[1] : null;
  return record?.demotedAt ? record : null;
};

// A demotion for refusals the turn-off rule counts, with nothing served since
// minWindowMs before its count began.
const isFirm = (conn, r) => !!r?.demotedAt && !r.modelScoped && !(conn.authDemoteOkAt >= r.firstAt)
  && !succeededSince(conn.id, new Date(r.firstAt).getTime() + 1)
  && !(new Date(r.servedAt).getTime() >= new Date(r.firstAt).getTime() - AUTH_DEAD_CONFIG.minWindowMs);

// Refused, in ways the turn-off rule counts, on 2 models with nothing served in
// between, the key is dead (tests/unit/auto-disable-stress.test.js replays it).
// `model` is refused now and returns the other model when:
// - the key is demoted on it, last refused there within minWindowMs, and
//   `model` was refused that way within minWindowMs before this refusal too;
// - or this refusal demotes `model`, and that demotion was last refused within
//   its probe interval and minWindowMs;
// - or the key is firmly demoted on `model` (this was a probe or a fallback)
//   and the other model was refused within minWindowMs.
function deadElsewhere(conn, records, model, current, demoting) {
  const now = Date.now();
  const since = (r) => now - new Date(r?.lastCountedAt).getTime();
  const firm = (r) => isFirm(conn, r);
  const others = records.filter(([m]) => m !== model);
  const found = (test) => others.find(([, r]) => test(r))?.[0] ?? null;
  return (since(current) <= AUTH_DEAD_CONFIG.minWindowMs && found(r => firm(r) && since(r) <= AUTH_DEAD_CONFIG.minWindowMs))
    || (demoting && found(r => firm(r) && since(r) <= probeMs(r.probeLevel || 0) + AUTH_DEAD_CONFIG.minWindowMs))
    || (firm(current) && found(r => since(r) <= AUTH_DEAD_CONFIG.minWindowMs))
    || null;
}

// The demotion side of a refusal: the record update for its model, whether it
// demotes the key there, and whether it shows the key dead on 2 models.
async function planDemotion(connections, conn, model, status, errorText, evidence, streakModels = []) {
  if (!conn) return { demote: null, demoting: false, deadWith: null };
  const modelEvidence = isModelRefusal(status, errorText)
    ? await authFailEvidence(connections, conn, model, status, errorText, isModelRefusal, authEvents.modelRefused) : null;
  const demoteEvidence = (Number(status) === 403 && evidence) || modelEvidence;
  if (!demoteEvidence) return { demote: null, demoting: false, deadWith: null };
  const records = demoteRecords(conn);
  const current = records.find(([m]) => m === model)?.[1] ?? null;
  // Defers to the turn-off rule only for models in its current count.
  const otherRefusalAt = modelEvidence ? -Infinity : Math.max(...records
    .filter(([m]) => m !== model && streakModels.includes(m)).map(([, r]) => new Date(r.lastCountedAt).getTime()).filter(Number.isFinite));
  const lastServedAt = Math.max(authEvents.success.get(conn.id)?.at ?? -Infinity, new Date(conn.authDemoteOkAt || NaN).getTime() || -Infinity);
  const to = nextDemoteRecord(current, Date.now(), {
    sameUpstream: demoteEvidence === "same-upstream", otherRefusalAt, modelScoped: !!modelEvidence, lastServedAt,
    reason: refusalText(status, errorText),
  });
  const demoting = !!to.demotedAt && !current?.demotedAt;
  // Refused here while demoted elsewhere: probe there now, once its last
  // probe's lease is over, to tell a key dead on both from one that has
  // recovered there. That includes demotions the key served since: a key
  // failing at random clears them sooner this way.
  const probeNow = evidence && !current?.demotedAt
    ? records.filter(([m, r]) => m !== model && !r.modelScoped).map(([m]) => m) : [];
  return {
    demote: {
      model, from: conn[getAuthDemoteKey(model)] ?? null, to, probeNow,
      data: demoting ? { lastError: `${model} demoted after repeated ${to.reason}` } : null,
    },
    demoting,
    deadWith: evidence ? deadElsewhere(conn, records, model, current, demoting) : null,
  };
}

// Takes the demoted key's next probe on the model: at most one per lease
// (probeLeaseMs) across requests, and no sooner than nextProbeAt, which a
// refused probe moves out.
async function claimProbe(conn, model, from) {
  const now = Date.now();
  if (now < new Date(from.nextProbeAt).getTime() || now < new Date(from.leaseUntil || 0).getTime()) return false;
  const leaseUntil = new Date(now + AUTH_DEMOTE_CONFIG.probeLeaseMs).toISOString();
  const to = { ...from, leaseUntil, probeId: randomUUID() };
  const saved = await updateProviderConnection(conn.id, {}, { demote: { model, from, to } });
  return JSON.stringify(saved?.[getAuthDemoteKey(model)]) === JSON.stringify(to);
}

// Locked on this model for a limit: a key that serves again once it clears.
// The lock that ends last decides, so a short limit lock can't hide a longer
// account-wide refusal.
function isLimitLocked(c, model) {
  const [scope, until] = [[getModelLockKey(model), model || "__all"], [MODEL_LOCK_ALL, "__all"]]
    .map(([key, sc]) => [sc, new Date(c[key] || 0).getTime() || 0])
    .reduce((a, b) => (b[1] > a[1] ? b : a));
  return until > Date.now() && c[`${MODEL_LIMIT_PREFIX}${scope}`] === true;
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 * @param {object} [options]
 * @param {string | null} [options.preferredConnectionId] - pinned connection (Codex
 *   session affinity), used when usable.
 * @param {((c: any) => boolean) | null} [options.connectionFilter] - drops
 *   connections the caller may not use at all.
 * @param {string[]} [options.warmConnectionIds] - keys holding this conversation's
 *   prompt cache, most recently used last. One is picked when it ranks with the
 *   strategy's own pick (round-robin: the most recent usable one).
 * @param {number} [options.maxWarmWaitMs] - when the strategy's pick isn't warm,
 *   another key could serve, and a warm key is only rate-limited so briefly that
 *   its retry (lock end + slack + jitter) is within this long, and no key the
 *   strategy ranks ahead of it is usable or frees up by then, returns
 *   `{ warmRetryAtMs }` instead of a key (nothing is picked or written).
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const warmIds = Array.isArray(options?.warmConnectionIds) && options.warmConnectionIds.length > 0
    ? new Set(options.warmConnectionIds)
    : null;
  const maxWarmWaitMs = Number(options?.maxWarmWaitMs) || 0;
  // Drops connections the caller may not use at all (auto combos skip blocked
  // billing), as if they were not connected.
  const connectionFilter = typeof options?.connectionFilter === "function" ? options.connectionFilter : null;
  // Resolve alias to provider ID (e.g., "kc" -> "kilocode") so aliases share a lock
  const providerId = resolveProviderId(provider);

  // Acquire this provider's mutex to prevent race conditions
  const currentMutex = selectionMutexes.get(providerId) || Promise.resolve();
  let resolveMutex;
  const nextMutex = new Promise(resolve => { resolveMutex = resolve; });
  selectionMutexes.set(providerId, nextMutex);

  try {
    await currentMutex;

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      if (connectionFilter && !connectionFilter({ provider: providerId })) return null;
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const allConnections = await getProviderConnections({ provider: providerId, isActive: true });
    const connections = connectionFilter ? allConnections.filter(c => connectionFilter(c)) : allConnections;
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    const settings = await getSettings();
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";
    const routingQuotas = strategy === "soonest-reset" ? getRoutingQuotas(providerId, connections) : new Map();
    const resetStates = new Map(connections.map(c => [c.id, getResetState(providerId, routingQuotas.get(c.id), model)]));

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;
    // Antigravity's live quota for this model is used up until a reset still ahead.
    const quotaBlocked = (c) => {
      const quota = antigravityQuotaCache?.get(c.id)?.[model];
      return !!(quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now());
    };

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const usable = (c) => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      if (resetStates.get(c.id).blockedUntil) return false;
      // A plan that cannot serve this model would only 400 upstream.
      if (!planCanServeModel(providerId, c, model)) {
        log.debug("AUTH", `${provider} | skipping ${c.name || c.id}: plan cannot serve ${model}`);
        return false;
      }
      // Antigravity: skip if live quota exhausted for this model
      if (quotaBlocked(c)) {
        const account = c.id?.slice(0, 8) || "unknown";
        log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${antigravityQuotaCache.get(c.id)[model].resetAt}`);
        return false;
      }
      return true;
    };
    // A key demoted on this model is used when no other key can serve it, or
    // for its next probe.
    const usableConnections = connections.filter(usable);
    const demotions = new Map(usableConnections.map(c => [c.id, demotionOf(c, model)]));
    const preferred = usableConnections.filter(c => !demotions.get(c.id));
    let availableConnections = preferred.length > 0 ? preferred : usableConnections;
    let probing = false;
    if (preferred.length > 0) {
      // Under fill-first a key behind a usable one wouldn't be tried anyway
      // (a backup), so only demoted keys ahead of them are probed.
      const ahead = strategy === "fill-first" ? usableConnections.slice(0, usableConnections.indexOf(preferred[0])) : usableConnections;
      for (const c of ahead.filter(c => demotions.get(c.id))) {
        if (await claimProbe(c, model, demotions.get(c.id))) {
          availableConnections = [c];
          probing = true;
          break;
        }
      }
    }

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      // Each account and when it can serve this model again; the soonest one
      // sets the retry time.
      const frees = (strategy === "soonest-reset"
        // An account needs both its error cooldown and exhausted quota to clear.
        ? connections.filter(c => planCanServeModel(providerId, c, model))
          .map(c => [c, Math.max(getModelLockUntil(c, model), resetStates.get(c.id).blockedUntil)])
        : lockedConns.map(c => [c, getModelLockUntil(c, model)]))
        .filter(([, until]) => until > Date.now());
      const expiries = frees.map(([, until]) => new Date(until).toISOString());
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        // A dead key's 403 ahead of a key in a 2s rate-limit lock would turn a
        // retryable wait into an auth failure.
        const limitLocked = c => isLimitLocked(c, model);
        // errorCode/lastError are the key's last error on any model; the limit
        // flag on the lock is this model's. Where they disagree, the stored error
        // came from another model.
        const reportOf = c => {
          const limited = limitLocked(c);
          const authCode = c.errorCode === 401 || c.errorCode === 403;
          const retryableCode = c.errorCode === 429 || c.errorCode >= 500;
          // A stored error that isn't a limit (an auth refusal, a 400/404) came from another model.
          if (limited && !retryableCode && !isLimitError(c.errorCode, c.lastError)) {
            return { code: 429, error: `Rate limited on ${model || "all models"}`, limit: true, own: true };
          }
          const unflagged = !limited && isModelLockActive(c, model);
          // A 429 here would have flagged this model's lock as a limit, so it is another model's.
          const otherModel = unflagged && c.errorCode === 429;
          // A 5xx lock can't be told from a refusal's: it may be this model's, so it
          // ranks as one, but it isn't proof enough to replace a 401/403.
          const maybeOther = unflagged && c.errorCode >= 500;
          // A 401/403 that only reads like a limit (a bodyless 403 says "quota") is still a refusal.
          return {
            code: c.errorCode || null, error: c.lastError || null,
            limit: limited && !authCode, ranks: !otherModel, own: !otherModel && !maybeOther,
          };
        };
        const soonestOf = list => list.reduce((soonest, f) => !soonest || f[1] < soonest[1] ? f : soonest, null)?.[0];
        // A limited key beats a dead one that frees up first, and a key with no
        // stored error (say one blocked only on quota) comes last.
        const earliestConn = soonestOf(frees.filter(([c]) => reportOf(c).limit))
          || soonestOf(frees.filter(([c]) => reportOf(c).ranks && (reportOf(c).code || reportOf(c).error)))
          || soonestOf(frees.filter(([c]) => reportOf(c).code || reportOf(c).error))
          || soonestOf(frees);
        const report = earliestConn ? reportOf(earliestConn) : { code: null, error: null, own: true };
        const eligibleConnections = connections.filter(c => planCanServeModel(providerId, c, model));
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${report.error?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          allLimitsExhausted: eligibleConnections.length > 0 && eligibleConnections.every(c => {
            const quota = antigravityQuotaCache?.get(c.id)?.[model];
            if (quota?.circuitBreaker) return false;
            const locked = isModelLockActive(c, model);
            // Only a lock still in force counts; the account-wide one can belong to a different model.
            const activeScopes = [[getModelLockKey(model), model || "__all"], [MODEL_LOCK_ALL, "__all"]]
              .filter(([key]) => new Date(c[key] || 0).getTime() > Date.now())
              .map(([, scope]) => scope);
            const limitedLock = locked && activeScopes.some(scope => c[`${MODEL_LIMIT_PREFIX}${scope}`] === true);
            return (!locked || limitedLock) && (limitedLock || resetStates.get(c.id).blockedUntil > Date.now() ||
              (quota?.remainingPercentage <= 0 && new Date(quota.resetAt).getTime() > Date.now()));
          }),
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          providerResetAtMs: getNextAccountReset(eligibleConnections, model, antigravityQuotaCache, resetStates),
          lastError: report.error,
          lastErrorCode: report.code,
          // False when the code may be another model's: it isn't proof this one will serve.
          lastErrorOwn: report.own
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    // Prompt-cache affinity. Fill-first and soonest-reset keep their own pick;
    // round-robin takes the conversation's most recently used usable warm key,
    // without moving the rotation, so neither this conversation nor other
    // traffic shifts the other. When the pick isn't warm, a warm key only
    // briefly rate-limited is worth waiting for, unless a key the strategy ranks
    // ahead of it (round-robin ranks none) is usable or frees up by the retry:
    // that key would win the pick after the wait. The caller gets
    // warmRetryAtMs instead of a key.
    let warmConnection = null;
    if (warmIds && !probing) {
      const recency = c => options.warmConnectionIds.lastIndexOf(c.id);
      if (strategy === "round-robin") {
        warmConnection = availableConnections.filter(c => warmIds.has(c.id))
          .reduce((a, b) => (!a || recency(b) > recency(a) ? b : a), null);
      }
      const pick = strategy === "round-robin" ? warmConnection
        : strategy === "soonest-reset" ? pickSoonestReset(availableConnections, resetStates)
          : availableConnections[0];
      if (pick && warmIds.has(pick.id)) {
        log.debug("AUTH", `${provider} | warm key for this conversation`);
      } else if (maxWarmWaitMs > 0) {
        const byPriority = (x, y) => (x.priority || 999) - (y.priority || 999);
        const ahead = (x, y) => {
          if (strategy === "round-robin") return false;
          if (strategy !== "soonest-reset") return byPriority(x, y) < 0;
          const [l, r] = [resetStates.get(x.id), resetStates.get(y.id)];
          return ((l.weeklyReset - r.weeklyReset || l.sessionReset - r.sessionReset || 0) || byPriority(x, y)) < 0;
        };
        const servable = c => !excludeSet.has(c.id) && !quotaBlocked(c) && !demotionOf(c, model) && planCanServeModel(providerId, c, model);
        const freeAt = c => Math.max(getModelLockUntil(c, model), resetStates.get(c.id).blockedUntil || 0);
        const jitterMs = warmJitterMs();
        const candidates = connections
          .filter(c => warmIds.has(c.id) && servable(c) && isLimitLocked(c, model) && !resetStates.get(c.id).blockedUntil)
          .sort((x, y) => getModelLockUntil(x, model) - getModelLockUntil(y, model));
        for (const c of candidates) {
          const warmRetryAtMs = warmRetryAt(getModelLockUntil(c, model), maxWarmWaitMs, jitterMs);
          if (warmRetryAtMs === null) break;
          if (connections.some(k => k.id !== c.id && servable(k) && ahead(k, c) && freeAt(k) <= warmRetryAtMs)) continue;
          log.debug("AUTH", `${provider} | warm key rate-limited, retrying it in ${warmRetryAtMs - Date.now()}ms`);
          return { warmRetryAtMs };
        }
      }
    }

    let connection = warmConnection;
    // Pin to preferred connection if specified and available
    if (!connection && preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "soonest-reset") {
      connection = pickSoonestReset(availableConnections, resetStates);
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    resolveMutex();
    // Drop the entry once no later caller has queued behind us
    if (selectionMutexes.get(providerId) === nextMutex) selectionMutexes.delete(providerId);
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, requestApiKey = undefined) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel, inOwnLock = false;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
    // A rate-limit error that lands while this model is already locked came from
    // a request sent before the lock: one burst escalates the backoff once, and
    // the model's own lock (and its provider reset) is kept, never shortened.
    if (newBackoffLevel != null && conn && isModelLockActive(conn, model)) {
      newBackoffLevel = backoffLevel;
      const ownLockUntil = new Date(conn[getModelLockKey(model)] || 0).getTime() || 0;
      inOwnLock = ownLockUntil > Date.now();
      cooldownMs = Math.max(ownLockUntil - Date.now(), getQuotaCooldown(backoffLevel));
    }
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);
  const providerResetAtMs = githubResetAtMs || resetsAtMs;
  const lockScope = githubResetAtMs ? "__all" : model || "__all";
  const limitKey = `${MODEL_LIMIT_PREFIX}${lockScope}`;

  // Auth rejections build a streak that only a success clears; other errors
  // leave it alone. A dead key is turned off unless it is the provider's last.
  const evidence = conn ? await authFailEvidence(connections, conn, model, status, errorText) : null;
  const authFailStreak = evidence ? nextAuthFailStreak(conn, model, status, evidence === "same-upstream") : null;
  const autoDisable = authFailStreak && isAuthDead(authFailStreak) ? {
    isActive: false,
    autoDisabledAt: new Date().toISOString(),
    autoDisabledReason: autoDisableReason(status, errorText, authFailStreak),
  } : null;
  // The same 403s, and ones refusing just this model, count on this model
  // alone toward demoting the key on it.
  const { demote, demoting, deadWith } = await planDemotion(connections, conn, model, status, errorText, evidence, authFailStreak?.authFailModels);
  const deadOnTwo = deadWith ? {
    isActive: false,
    autoDisabledAt: new Date().toISOString(),
    autoDisabledReason: `${refusalText(status, errorText)} on ${deadWith}, ${model}`,
  } : null;
  const disabling = autoDisable || deadOnTwo;

  const update = {
    ...lockUpdate,
    // A straggler in the model's own lock can mark it a limit, never unmark it or drop its reset time.
    [limitKey]: (inOwnLock && conn[limitKey] === true) || isLimitError(status, errorText),
    ...(inOwnLock ? {} : {
      [`${PROVIDER_RESET_PREFIX}${lockScope}`]:
        Number.isFinite(providerResetAtMs) && providerResetAtMs > Date.now() ? new Date(providerResetAtMs).toISOString() : null,
    }),
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
    ...authFailStreak,
  };
  // A key pasted in while this request was on its way isn't blamed for it.
  const options = authFailStreak || demote ? [{ autoDisable: disabling, demote, apiKeyUsed: requestApiKey ?? conn.apiKey }] : [];
  const saved = await updateProviderConnection(connectionId, update, ...options);
  const turnedOff = disabling && saved?.isActive === false && saved.autoDisabledAt === disabling.autoDisabledAt;
  const recorded = demote && JSON.stringify(saved?.[getAuthDemoteKey(model)]) === JSON.stringify(demote.to);
  if (recorded) authEvents.demoteKeys.add(connectionId);
  const demoted = demoting && recorded;

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);
  if (turnedOff) log.warn("AUTH", `${connName} turned off automatically: ${disabling.autoDisabledReason}`);
  if (demoted) log.warn("AUTH", `${connName} demoted on ${model} after repeated ${status}s`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs, providerResetAtMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  recordSuccess(connectionId, model);
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  // A cleared lock stays as modelLock_<model>: null and needs no write, unless
  // whatever cleared it left its reset time or limit flag behind.
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_")
    && (conn[k] || conn[k.replace("modelLock_", PROVIDER_RESET_PREFIX)] || conn[k.replace("modelLock_", MODEL_LIMIT_PREFIX)]));

  // The model's demotion record goes, even one written after the snapshot. A
  // record on another model stays, and authDemoteOkAt notes the key served
  // since its count began: once for a record in the snapshot, once after this
  // process last wrote a record (which the snapshot may predate), and once on
  // the key's first success since the process started, which a count starting
  // soon after a restart can't otherwise see.
  const demoteRecord = !!model && !!conn[getAuthDemoteKey(model)];
  const otherRecords = Object.entries(conn).filter(([k, r]) => k.startsWith(AUTH_DEMOTE_PREFIX) && k !== getAuthDemoteKey(model) && r);
  const firstThisBoot = !authEvents.servedKeys.has(connectionId);
  if (firstThisBoot) authEvents.servedKeys.add(connectionId);
  const noteServed = authEvents.demoteKeys.delete(connectionId) || firstThisBoot
    || otherRecords.some(([, r]) => !(conn.authDemoteOkAt >= r.firstAt));
  const demoteWrite = demoteRecord || noteServed;
  if (!conn.testStatus && !conn.lastError && !conn.errorCode && allLockKeys.length === 0 && !conn.authFailCount && !demoteWrite) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    if (!expiry) return true;                              // lock already cleared
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError && !conn.errorCode && !conn.authFailCount && !demoteWrite) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));
  // Any success proves the key works, whatever model failed before.
  if (conn.authFailCount) Object.assign(clearObj, AUTH_FAIL_CLEARED);
  for (const key of keysToClear) {
    clearObj[key.replace("modelLock_", PROVIDER_RESET_PREFIX)] = null;
    clearObj[key.replace("modelLock_", MODEL_LIMIT_PREFIX)] = null;
  }

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }
  if (Object.keys(clearObj).length === 0 && !demoteWrite) return;

  await updateProviderConnection(connectionId, clearObj, { liftDemote: model, noteServed });
}

/**
 * Extract the client's API key: the same sources the middleware accepts.
 */
export function extractApiKey(request) {
  return extractClientApiKey(request);
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
