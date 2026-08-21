import { NOTIFICATION_EVENTS } from "./constants.js";

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function getQuotaRemainingPercentage(quota) {
  if (!quota || quota.unlimited === true) return null;
  const remainingPercentage = finiteNumber(quota.remainingPercentage);
  if (remainingPercentage !== null) return Math.max(0, remainingPercentage);

  const used = finiteNumber(quota.used);
  const total = finiteNumber(quota.total);
  if (used !== null && total !== null && total > 0) {
    return Math.max(0, ((total - used) / total) * 100);
  }

  const remaining = finiteNumber(quota.remaining);
  if (remaining !== null && total !== null && total > 0) {
    return Math.max(0, (remaining / total) * 100);
  }
  return null;
}

export function buildQuotaSnapshot(usage) {
  const snapshot = {};
  for (const [name, quota] of Object.entries(usage?.quotas || {})) {
    const remainingPercentage = getQuotaRemainingPercentage(quota);
    if (remainingPercentage === null) continue;
    snapshot[name] = {
      exhausted: remainingPercentage <= 0,
      remainingPercentage,
      resetAt: quota?.resetAt || null,
    };
  }
  return snapshot;
}

export function detectQuotaTransitions(previousState, usage) {
  const previousQuotas = previousState?.quotas || {};
  const quotas = buildQuotaSnapshot(usage);
  const events = [];

  for (const [name, current] of Object.entries(quotas)) {
    const previous = previousQuotas[name];
    if (previous && current.exhausted && previous.exhausted !== true) {
      events.push({
        type: NOTIFICATION_EVENTS.QUOTA_EXHAUSTED,
        quotaName: name,
        ...current,
      });
    } else if (!current.exhausted && previous?.exhausted === true) {
      events.push({
        type: NOTIFICATION_EVENTS.QUOTA_RESET,
        quotaName: name,
        ...current,
      });
    }
  }

  return {
    events,
    state: {
      quotas,
      updatedAt: new Date().toISOString(),
    },
  };
}
