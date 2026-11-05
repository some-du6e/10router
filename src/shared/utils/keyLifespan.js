// Key lifespan estimate: how much of an active key's budget is left, judged by
// how much earlier keys of the same provider consumed before they were turned
// off automatically. Pure functions, shared by the server (estimate) and the
// dashboard (label).

export const LIFESPAN_MIN_DEAD_KEYS = 3;
// Dead keys below this share of the median died of something else (a locked
// account, a revoked key) and would drag the estimate down.
export const LIFESPAN_OUTLIER_SHARE = 0.25;
// Burn rate window, and the shortest span a rate is computed over so one
// request on a brand-new key doesn't read as a huge hourly rate.
export const LIFESPAN_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
export const LIFESPAN_MIN_RATE_SPAN_MS = 15 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

// Linear-interpolated percentile of an ascending array.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {Array<{id: string, isActive?: boolean, autoDisabledAt?: string|null}>} keyWindows
 *   one per key: a connection's current key, or a key it had before
 * @param {Record<string, {cost?: number, tokens?: number, recentCost?: number, recentTokens?: number, firstAt?: string|null}>} usage
 *   per key window id, successful requests only; recent* cover LIFESPAN_RECENT_WINDOW_MS
 * @param {{ now?: number }} [opts]
 * @returns {{ estimate: null | { metric: "cost"|"tokens", median: number, low: number, high: number, sampleSize: number, excluded: number }, keys: Record<string, object> }}
 */
export function estimateKeyLifespans(keyWindows, usage, opts = {}) {
  const now = opts.now ?? Date.now();
  const of = (id) => usage?.[id] || {};

  // A dead key that never served anything says nothing about the budget, and
  // would flip the unit to tokens or pull the median to zero.
  const dead = (keyWindows || []).filter((c) => c.isActive === false && c.autoDisabledAt
    && (num(of(c.id).cost) > 0 || num(of(c.id).tokens) > 0));
  if (dead.length < LIFESPAN_MIN_DEAD_KEYS) return { estimate: null, keys: {} };

  // Cost when every dead key has one; otherwise pricing is missing for some of
  // the models and tokens are the only comparable measure.
  const metric = dead.every((c) => num(of(c.id).cost) > 0) ? "cost" : "tokens";
  const consumed = (u) => num(metric === "cost" ? u.cost : u.tokens);

  const all = dead.map((c) => consumed(of(c.id))).sort((a, b) => a - b);
  const rawMedian = percentile(all, 0.5);
  if (!(rawMedian > 0)) return { estimate: null, keys: {} };
  const kept = all.filter((v) => v >= rawMedian * LIFESPAN_OUTLIER_SHARE);
  if (kept.length < LIFESPAN_MIN_DEAD_KEYS) return { estimate: null, keys: {} };

  const estimate = {
    metric,
    median: percentile(kept, 0.5),
    low: percentile(kept, 0.25),
    high: percentile(kept, 0.75),
    sampleSize: kept.length,
    excluded: all.length - kept.length,
  };

  const keys = {};
  for (const c of keyWindows || []) {
    if (c.isActive === false) continue;
    const u = of(c.id);
    // Served tokens with no cost: its models aren't priced, so its spend is
    // unknown and it would read ~100% left forever.
    if (metric === "cost" && !(num(u.cost) > 0) && num(u.tokens) > 0) continue;
    const used = consumed(u);
    const recent = num(metric === "cost" ? u.recentCost : u.recentTokens);
    const firstMs = u.firstAt ? Date.parse(u.firstAt) : NaN;
    const windowStart = now - LIFESPAN_RECENT_WINDOW_MS;
    const spanStart = Number.isFinite(firstMs) ? Math.max(windowStart, firstMs) : windowStart;
    const spanMs = Math.max(now - spanStart, LIFESPAN_MIN_RATE_SPAN_MS);
    const ratePerHour = recent > 0 ? recent / (spanMs / HOUR_MS) : null;
    const remaining = Math.max(0, estimate.median - used);
    keys[c.id] = {
      metric,
      used,
      budget: estimate.median,
      low: estimate.low,
      high: estimate.high,
      percentLeft: Math.max(0, 100 - (used / estimate.median) * 100),
      remaining,
      ratePerHour,
      etaHours: ratePerHour && remaining > 0 ? remaining / ratePerHour : null,
      sampleSize: estimate.sampleSize,
      excluded: estimate.excluded,
    };
  }
  return { estimate, keys };
}

function formatAmount(metric, v) {
  if (metric === "cost") return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
  const abs = Math.abs(v);
  const short = abs >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : abs >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${Math.round(v)}`;
  return `${short} tokens`;
}

export function formatDuration(hours) {
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `~${Math.round(hours)}h`;
  return `~${Math.round(hours / 24)}d`;
}

// The row label for a connection (its lifespan from /api/providers/lifespan),
// or null when it's off or has no estimate.
export function lifespanLabel(connection) {
  const lifespan = connection?.lifespan;
  if (connection?.isActive === false || !lifespan || !(lifespan.budget > 0)) return null;
  const { metric, used, budget, low, high, remaining, etaHours, sampleSize, excluded } = lifespan;
  const fmt = (v) => formatAmount(metric, v);
  const past = remaining <= 0;
  const text = past
    ? "Past typical lifespan"
    : `${lifespan.percentLeft < 0.5 ? "<1%" : `~${Math.round(lifespan.percentLeft)}%`} left${etaHours ? ` · ${formatDuration(etaHours)} at current pace` : ""}`;
  const lines = [
    `Used ${fmt(used)} of a typical ${fmt(budget)} (earlier keys lasted ${fmt(low)}–${fmt(high)}).`,
    `Based on ${sampleSize} earlier key${sampleSize === 1 ? "" : "s"} turned off automatically${excluded ? `, ignoring ${excluded} that died early` : ""}.`,
  ];
  if (!past && !etaHours) lines.push("No recent traffic, so no time estimate.");
  return { text, title: lines.join("\n") };
}

