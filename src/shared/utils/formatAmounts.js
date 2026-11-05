// Compact money and count formats shared by the dashboard pages.

/** Compact USD. Keeps cents below $10 — rounding "$3.61" to "$4" throws away
 *  a meaningful chunk at the scale a new account lives at. */
export function fmtMoney(value) {
  const n = Number(value) || 0;
  if (n === 0) return "$0";
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${Math.round(n).toLocaleString()}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `$${k < 10 ? k.toFixed(2).replace(/\.?0+$/, "") : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `$${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Compact token/request counts: 412, 19.6K, 1.67B. */
export function fmtCount(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
