import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, getModelLockKey, MODEL_LOCK_ALL } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, AUTH_DEAD_CONFIG } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { planCanServeModel } from "@/shared/utils/planCapability.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { getRoutingQuotas, getResetState, pickSoonestReset } from "./soonestReset.js";
import * as log from "../utils/logger.js";
import { getNextAccountReset, PROVIDER_RESET_PREFIX, extractProviderMessage } from "./accountFailureSummary.js";
import { isLimitError } from "open-sse/utils/limitHold.js";

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

const AUTH_FAIL_CLEARED = { authFailCount: null, authFailFirstAt: null, authFailLastAt: null, authFailModels: null };
const MAX_TRACKED_MODELS = 5;
const REASON_MAX_CHARS = 80;
const MAX_SUCCESS_ENTRIES = 5000;

// Last success time per connection and per `${connectionId}|${model}`. Memory
// only, so the success path never writes the DB; after a restart it is empty
// and keys just take longer to trip.
const authSuccess = (global._authSuccess ??= new Map());

function recordSuccess(connectionId, model) {
  const now = Date.now();
  if (authSuccess.size >= MAX_SUCCESS_ENTRIES) {
    for (const [key, at] of authSuccess) if (now - at > AUTH_DEAD_CONFIG.minWindowMs) authSuccess.delete(key);
    if (authSuccess.size >= MAX_SUCCESS_ENTRIES) authSuccess.clear();
  }
  authSuccess.set(connectionId, now);
  if (model) authSuccess.set(`${connectionId}|${model}`, now);
}

const succeededSince = (key, sinceMs) => (authSuccess.get(key) ?? -Infinity) >= sinceMs;

// Budget and spend 403s that isLimitError doesn't know ("Key limit exceeded
// (daily limit)", "monthly spend limit", "credits exhausted"): the key is fine.
const SPEND_LIMIT_403 = /limit exceeded|exceeded (?:your|the|its)?\s*\w*\s*limit|spend(?:ing)? limit|credit|quota|usage cap|billing|budget|insufficient (?:funds|balance)/i;

// 401, or a 403 that is not a quota/rate/spend limit: the key itself is refused.
function isAuthRejection(status, errorText) {
  const code = Number(status);
  if (code === 401) return true;
  return code === 403 && !isLimitError(code, errorText) && !SPEND_LIMIT_403.test(String(errorText || ""));
}

// The refusal only counts when another key of the provider served this model
// recently: a failure every key sees (region block, proxy page, auth outage)
// is not this key's. Web search/fetch lock keys ("websearch:x") are not models.
function countsTowardAuthStreak(connections, connectionId, model, status, errorText) {
  if (!model || model.includes(":") || !isAuthRejection(status, errorText)) return false;
  const since = Date.now() - AUTH_DEAD_CONFIG.minWindowMs;
  return connections.some(c => c.id !== connectionId && succeededSince(`${c.id}|${model}`, since));
}

function nextAuthFailStreak(conn, model) {
  const now = Date.now();
  const firstAt = new Date(conn.authFailFirstAt || NaN).getTime();
  const sinceLast = now - new Date(conn.authFailLastAt || conn.authFailFirstAt || NaN).getTime();
  // Starts over when the last counted failure is old (a backup key left with
  // an outage's leftovers), when this key succeeded after the streak began on
  // a request whose snapshot predates it, or when a timestamp is unreadable or
  // in the future (the negated range check is also false for NaN).
  const fresh = !(now - firstAt >= 0)
    || !(sinceLast >= 0 && sinceLast <= AUTH_DEAD_CONFIG.minWindowMs)
    || succeededSince(conn.id, firstAt + 1);
  const models = !fresh && Array.isArray(conn.authFailModels) ? conn.authFailModels : [];
  return {
    authFailCount: (fresh ? 0 : conn.authFailCount || 0) + 1,
    authFailFirstAt: fresh ? new Date(now).toISOString() : conn.authFailFirstAt,
    authFailLastAt: new Date(now).toISOString(),
    authFailModels: models.includes(model) ? models : [...models, model].slice(-MAX_TRACKED_MODELS),
  };
}

function isAuthDead(streak, status) {
  return streak.authFailCount >= AUTH_DEAD_CONFIG.minFailures
    && Date.now() - new Date(streak.authFailFirstAt).getTime() >= AUTH_DEAD_CONFIG.minWindowMs
    && (Number(status) === 401 || streak.authFailModels.length >= AUTH_DEAD_CONFIG.minModels);
}

function autoDisableReason(status, errorText, streak) {
  const text = String(extractProviderMessage(errorText)).replace(/^\[\d+\]:\s*/, "").replace(/\s+/g, " ").trim();
  const message = text.length > REASON_MAX_CHARS ? `${text.slice(0, REASON_MAX_CHARS - 1)}…` : text;
  return `${status}${message ? ` "${message}"` : ""} on ${streak.authFailModels.join(", ")}`;
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
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

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      if (resetStates.get(c.id).blockedUntil) return false;
      // A plan that cannot serve this model would only 400 upstream.
      if (!planCanServeModel(providerId, c, model)) {
        log.debug("AUTH", `${provider} | skipping ${c.name || c.id}: plan cannot serve ${model}`);
        return false;
      }
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

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
      const expiries = strategy === "soonest-reset"
        ? connections.filter(c => planCanServeModel(providerId, c, model)).map(c => {
          // An account needs both its error cooldown and exhausted quota to clear.
          const lock = new Date(c[getModelLockKey(model)] || c[MODEL_LOCK_ALL] || 0).getTime();
          return Math.max(Number.isFinite(lock) ? lock : 0, resetStates.get(c.id).blockedUntil);
        }).filter(until => until > Date.now()).map(until => new Date(until).toISOString())
        : lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        const eligibleConnections = connections.filter(c => planCanServeModel(providerId, c, model));
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          allLimitsExhausted: eligibleConnections.length > 0 && eligibleConnections.every(c => {
            const quota = antigravityQuotaCache?.get(c.id)?.[model];
            if (quota?.circuitBreaker) return false;
            const locked = isModelLockActive(c, model);
            // The account-wide last error can belong to a different model.
            const lockScope = c[getModelLockKey(model)] ? model || "__all" : "__all";
            const limitedLock = locked && c[`${MODEL_LIMIT_PREFIX}${lockScope}`] === true;
            return (!locked || limitedLock) && (limitedLock || resetStates.get(c.id).blockedUntil > Date.now() ||
              (quota?.remainingPercentage <= 0 && new Date(quota.resetAt).getTime() > Date.now()));
          }),
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          providerResetAtMs: getNextAccountReset(eligibleConnections, model, antigravityQuotaCache, resetStates),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
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
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
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
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);
  const providerResetAtMs = githubResetAtMs || resetsAtMs;

  // Auth rejections build a streak that only a success clears; other errors
  // leave it alone. A dead key is turned off unless it is the provider's last.
  const authFailStreak = conn && countsTowardAuthStreak(connections, connectionId, model, status, errorText)
    ? nextAuthFailStreak(conn, model) : null;
  let autoDisable = null;
  if (authFailStreak && conn.isActive !== false && isAuthDead(authFailStreak, status)
    && connections.some(c => c.id !== connectionId && c.isActive !== false)) {
    autoDisable = {
      isActive: false,
      autoDisabledAt: new Date().toISOString(),
      autoDisabledReason: autoDisableReason(status, errorText, authFailStreak),
    };
  }

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    [`${MODEL_LIMIT_PREFIX}${githubResetAtMs ? "__all" : model || "__all"}`]: isLimitError(status, errorText),
    [`${PROVIDER_RESET_PREFIX}${githubResetAtMs ? "__all" : model || "__all"}`]:
      Number.isFinite(providerResetAtMs) && providerResetAtMs > Date.now() ? new Date(providerResetAtMs).toISOString() : null,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
    ...authFailStreak,
    ...autoDisable,
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);
  if (autoDisable) log.warn("AUTH", `${connName} turned off automatically: ${autoDisable.autoDisabledReason}`);

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
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0 && !conn.authFailCount) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError && !conn.authFailCount) return;

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

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
