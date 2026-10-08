import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const FETCHERS = { claude: getClaudeUsage, codex: getCodexUsage };
const REFRESH_MS = 60_000;
const MAX_AGE_MS = 300_000;
const TIMEOUT_MS = 15_000;
const cache = new Map();

// Requests use the last snapshot, including on a cold start. Quota endpoints
// must never hold up account selection or its shared mutex.
export function getRoutingQuotas(provider, connections) {
  const fetchUsage = FETCHERS[provider];
  const snapshots = new Map();
  if (!fetchUsage) return snapshots;
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (!entry.pending && now - entry.at > MAX_AGE_MS) cache.delete(id);
  }
  for (const connection of connections) {
    if (!connection.accessToken) continue;
    const key = `${provider}:${connection.id}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = { at: 0, fetchedAt: 0, quotas: null, pending: false };
      cache.set(key, entry);
    }
    if (entry.quotas && now - entry.fetchedAt < MAX_AGE_MS) {
      snapshots.set(connection.id, entry.quotas);
    }
    if (entry.pending || (entry.at && now - entry.at < REFRESH_MS)) continue;
    entry.pending = true;
    entry.at = now;
    let timer;
    const fetch = async () => {
      const proxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      return fetchUsage(connection.accessToken, proxy);
    };
    Promise.race([
      fetch(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Quota refresh timed out")), TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).then((usage) => {
      if (usage?.quotas && !usage.message) {
        entry.quotas = usage.quotas;
        entry.fetchedAt = Date.now();
      }
    }).catch(() => {
      // Missing usage is unknown, never evidence that an account is exhausted.
    }).finally(() => {
      clearTimeout(timer);
      entry.pending = false;
    });
  }
  return snapshots;
}

export function getResetState(provider, quotas, model, now = Date.now()) {
  let weekly;
  let session;
  let modelWeekly;
  if (provider === "codex") {
    const prefix = model?.toLowerCase().includes("spark") ? "spark_" : "";
    weekly = quotas?.[`${prefix}weekly`];
    session = quotas?.[`${prefix}session`];
  } else if (provider === "claude") {
    weekly = quotas?.["weekly (7d)"];
    session = quotas?.["session (5h)"];
    const family = model?.toLowerCase().match(/(?:^|[-/])(opus|sonnet|haiku)(?:-|$)/)?.[1];
    modelWeekly = family ? quotas?.[`weekly ${family} (7d)`] : null;
  }
  const futureReset = (quota) => {
    const reset = quota?.resetAt ? new Date(quota.resetAt).getTime() : NaN;
    return Number.isFinite(reset) && reset > now && !quota.unlimited ? reset : Infinity;
  };
  const windows = [weekly, session, modelWeekly];
  const blockedUntil = windows.reduce((until, quota) => {
    const reset = futureReset(quota);
    const exhausted = quota && (quota.remaining === 0 || quota.remainingPercentage === 0 ||
      (Number.isFinite(quota.used) && Number.isFinite(quota.total) && quota.total > 0 && quota.used >= quota.total));
    return exhausted && reset !== Infinity ? Math.max(until, reset) : until;
  }, 0);
  return {
    blockedUntil,
    weeklyReset: Math.min(futureReset(weekly), futureReset(modelWeekly)),
    sessionReset: futureReset(session),
  };
}

export function pickSoonestReset(connections, states) {
  return [...connections].sort((a, b) => {
    const left = states.get(a.id);
    const right = states.get(b.id);
    return (left.weeklyReset - right.weeklyReset || left.sessionReset - right.sessionReset || 0);
  })[0];
}
