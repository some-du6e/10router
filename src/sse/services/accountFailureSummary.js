function extractProviderMessage(error) {
  const text = typeof error === "string" ? error : JSON.stringify(error || "Provider error");
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return text;

  try {
    const payload = JSON.parse(text.slice(jsonStart));
    return payload?.error?.message || payload?.message || text;
  } catch {
    return text;
  }
}

export function summarizeAccountFailures(provider, model, failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return `All accounts unavailable for [${provider}/${model}]`;
  }

  const details = failures.map(({ account, status, error }) => {
    const name = account || "Unnamed account";
    const statusLabel = status ? `HTTP ${status}` : "provider error";
    return `${name} (${statusLabel}): ${extractProviderMessage(error)}`;
  });

  return `All ${failures.length} accounts unavailable for [${provider}/${model}]. ${details.join(" | ")}`;
}

export const PROVIDER_RESET_PREFIX = "providerReset_";

export function getNextAccountReset(connections, model, quotaCache = null, resetStates = null) {
  const resets = connections.map(connection => {
    const quota = quotaCache?.get(connection.id)?.[model];
    const timestamps = [connection[`${PROVIDER_RESET_PREFIX}${model || "__all"}`], connection[`${PROVIDER_RESET_PREFIX}__all`],
      quota?.remainingPercentage <= 0 ? quota.resetAt : null, resetStates?.get(connection.id)?.blockedUntil];
    const active = timestamps.map(value => value ? new Date(value).getTime() : 0).filter(time => time > Date.now());
    return active.length ? Math.max(...active) : null;
  });
  // Unknown resets could precede the known ones, so don't guess the next reset.
  return resets.length && resets.every(Boolean) ? Math.min(...resets) : null;
}

export function formatAccountLimitMessage(resetAtMs = null) {
  const summary = "All your accounts have hit their limits.";
  if (!Number.isFinite(resetAtMs) || resetAtMs <= Date.now()) return summary;
  const seconds = Math.ceil((resetAtMs - Date.now()) / 1000);
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const parts = seconds < 60 ? [[seconds, "second"]] : [[hours, "hour"], [minutes % 60, "minute"]];
  const delay = parts.filter(([value]) => value).map(([value, unit]) => `${value} ${unit}${value === 1 ? "" : "s"}`).join(" ");
  return `${summary} Next account resets in ${delay}.`;
}
