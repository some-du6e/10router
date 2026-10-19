const clamp = (value) => Math.min(100, Math.max(0, value));

export function quotaRemaining(quota) {
  if (quota.unlimited) return 100;
  if (Number.isFinite(quota.remainingPercentage))
    return clamp(quota.remainingPercentage);
  if (Number.isFinite(quota.remaining)) return clamp(quota.remaining);
  if (
    Number.isFinite(quota.total) &&
    quota.total > 0 &&
    Number.isFinite(quota.used)
  ) {
    return clamp((1 - quota.used / quota.total) * 100);
  }
  return null;
}

function windowIdentity(provider, quota) {
  const name = String(quota.name || "Quota");
  const key = quota.quotaType || quota.modelKey || name;
  const lower = name.toLowerCase();
  if (
    (provider === "codex" && key === "session" && lower !== "monthly") ||
    /^(session(?: \(5h\))?|5h|5-hour|session \(5h\))$/i.test(name)
  ) {
    return { key: "session", kind: "session", label: "5-hour limit" };
  }
  if (/^(weekly(?: \(7d\))?|7-day|weekly \(7d\))$/i.test(name)) {
    return {
      key: "weekly",
      kind: "weekly",
      label: provider === "claude" ? "7-day limit" : "Weekly limit",
    };
  }
  if (lower === "monthly")
    return { key: "monthly", kind: "monthly", label: "Monthly limit" };
  if (provider === "kimi" && lower === "ratelimit") {
    return { key: "session", kind: "session", label: "Session limit" };
  }
  return { key, kind: "other", label: name };
}

export function buildAccount(connection, entry, error) {
  const windows = (entry?.quotas || [])
    .filter((q) => !q.message)
    .map((quota) => ({
      ...quota,
      ...windowIdentity(connection.provider, quota),
      remaining: quotaRemaining(quota),
    }));
  const weekly = windows.find((q) => q.kind === "weekly");
  const session = windows.find((q) => q.kind === "session");
  const primary = windows.filter((q) => q.kind !== "other");
  const mainWindows = primary.length ? primary : windows;
  const weeklyBlocked = weekly?.remaining === 0;
  const priority = weeklyBlocked ? weekly : session || weekly || mainWindows[0];
  const orderedWindows = priority
    ? [priority, ...mainWindows.filter((q) => q !== priority)]
    : [];
  // Status follows the tightest window, so a low weekly bar never sits next to "Healthy".
  const known = orderedWindows.filter((q) => q.remaining !== null);
  const remaining = known.length
    ? Math.min(...known.map((q) => q.remaining))
    : null;
  const health =
    remaining === null
      ? "Unknown"
      : remaining === 0
        ? "Depleted"
        : remaining < 30
          ? "Low quota"
          : "Healthy";
  return {
    ...connection,
    name:
      connection.name?.trim() ||
      connection.displayName?.trim() ||
      connection.email?.trim() ||
      "Unnamed account",
    plan: entry?.plan || "Not reported",
    windows,
    mainWindows: orderedWindows,
    priority,
    weeklyBlocked,
    weeklyUnknown: !!weekly && weekly.remaining === null,
    worstRemaining: remaining,
    health,
    status: connection.isActive === false ? "Turned off" : health,
    updatedAt: entry?.updatedAt || entry?.cachedAt || null,
    error: error || null,
    message: entry?.message || null,
  };
}

export function usableRemaining(account) {
  if (account.isActive === false || account.weeklyBlocked) return 0;
  if (account.weeklyUnknown) return null;
  return account.priority?.remaining ?? null;
}

export function compareBarAccounts(a, b) {
  const rank = (account) =>
    account.isActive === false
      ? 3
      : account.weeklyBlocked
        ? 2
        : usableRemaining(account) === null
          ? 1
          : 0;
  return (
    rank(a) - rank(b) ||
    (usableRemaining(b) ?? -1) - (usableRemaining(a) ?? -1) ||
    a.id.localeCompare(b.id)
  );
}

export function resetTimestamp(quota) {
  const value = quota?.resetAt ? new Date(quota.resetAt).getTime() : NaN;
  return Number.isFinite(value) ? value : Infinity;
}

export function compareAccounts(a, b, sort) {
  const remaining =
    (a.priority?.remaining ?? Infinity) - (b.priority?.remaining ?? Infinity);
  const reset = resetTimestamp(a.priority) - resetTimestamp(b.priority);
  const fallback = a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (sort === "reset") return reset || remaining || fallback;
  if (sort === "remaining-desc") return -remaining || reset || fallback;
  if (sort === "remaining") return remaining || reset || fallback;
  return a.provider.localeCompare(b.provider) || remaining || reset || fallback;
}

export function summarizeWindow(accounts, window) {
  const values = accounts.map((account) => {
    const quota = account.windows.find((q) => q.key === window.key);
    const blocked =
      account.isActive === false
        ? "Turned off"
        : window.kind === "session" && account.weeklyBlocked
          ? "Weekly exhausted"
          : window.kind === "session" && account.weeklyUnknown
            ? "Weekly quota unknown"
            : null;
    return { account, quota, blocked };
  });
  const reported = values.filter((v) => v.quota?.remaining != null);
  const usable = reported.filter((v) => !v.blocked);
  const counted = reported.filter((v) => v.account.isActive !== false);
  const usableSum = usable.reduce((sum, v) => sum + v.quota.remaining, 0);
  const resets = values
    .filter((v) => v.account.isActive !== false)
    .map((v) => resetTimestamp(v.quota))
    .filter(Number.isFinite);
  return {
    values,
    total: reported.length ? usableSum : null,
    // Blocked accounts count as empty, so the average reflects routable quota.
    average: reported.length ? usableSum / (counted.length || 1) : null,
    averaged: counted.length > 1,
    capacity:
      values.filter((v) => v.account.isActive !== false && v.quota).length *
      100,
    unknown: values.filter(
      (v) =>
        v.account.isActive !== false &&
        (!v.quota || v.quota.remaining === null),
    ).length,
    stale: values.filter((v) => v.account.error).length,
    nextReset: resets.length ? Math.min(...resets) : null,
  };
}

export function providerWindows(accounts) {
  const windows = new Map();
  accounts.forEach((a) => a.mainWindows.forEach((q) => windows.set(q.key, q)));
  const weeklyFirst =
    accounts.some((a) => a.isActive !== false) &&
    accounts.filter((a) => a.isActive !== false).every((a) => a.weeklyBlocked);
  const rank = (q) =>
    q.kind === (weeklyFirst ? "weekly" : "session")
      ? 0
      : q.kind === (weeklyFirst ? "session" : "weekly")
        ? 1
        : 2;
  return [...windows.values()].sort((a, b) => rank(a) - rank(b));
}

export function formatRemaining(value) {
  return value === null || value === undefined
    ? "—"
    : `${Math.round(value * 10) / 10}%`;
}

export function resetLabel(quota, now = Date.now()) {
  const time = resetTimestamp(quota);
  if (!Number.isFinite(time)) return "Reset not reported";
  if (time <= now) return quota.recurring === false ? "Expired" : "Reset due";
  const minutes = Math.ceil((time - now) / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const [big, small, unit, subunit] = days
    ? [days, hours % 24, "d", "h"]
    : hours
      ? [hours, minutes % 60, "h", "m"]
      : [minutes, 0, "m", ""];
  const duration = small ? `${big}${unit} ${small}${subunit}` : `${big}${unit}`;
  return `${quota.recurring === false ? "Expires" : "Resets"} in ${duration}`;
}

// Bare duration for compact cells, e.g. "45m" or "2d 3h".
export function resetShort(quota, now = Date.now()) {
  if (!Number.isFinite(resetTimestamp(quota))) return null;
  return resetLabel(quota, now).replace(/^(Resets|Expires) in /, "");
}

export function updatedLabel(date, now = Date.now()) {
  if (!date || !Number.isFinite(new Date(date).getTime()))
    return "Not updated yet";
  const minutes = Math.max(
    0,
    Math.floor((now - new Date(date).getTime()) / 60000),
  );
  return minutes === 0
    ? "Updated just now"
    : minutes < 60
      ? `Updated ${minutes} minutes ago`
      : `Updated ${Math.floor(minutes / 60)} hours ago`;
}
