export { fmtMoney, fmtCount } from "@/shared/utils/formatAmounts.js";

/**
 * Does this string look like an email address?
 *
 * Matching on shape rather than comparing against the connection's `email`
 * field: an account's `name` is very often the address too, and comparing
 * fields misses it whenever the two differ by case or whitespace. Anything
 * shaped like an address gets blurred and never title-cased.
 */
export function looksLikeEmail(text) {
  if (!text || typeof text !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

/** Coarse duration for countdowns: "3h 12m", "6d 13h", "45m". */
export function fmtDuration(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function fmtRelative(timestamp) {
  if (!timestamp) return "never";
  const diff = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diff)) return "never";
  // A future timestamp is a countdown, not "just now" — token expiry and quota
  // resets both live in the future and read as nonsense otherwise.
  if (diff < 0) return `in ${fmtDuration(-diff)}`;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** "2026-08-13" → "Aug 13" */
export function fmtDayLabel(dateKey) {
  if (!dateKey) return "";
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "2026-08" → "Aug 2026" */
export function fmtMonthLabel(monthKey) {
  if (!monthKey) return "";
  const [y, m] = monthKey.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, 1);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function fmtTimeOfDay(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Return multiple: one decimal below 10x, whole numbers above.
 *
 * Shared by the headline, the value panel and the month table — rounding a
 * 1.4x return to "1x" in one place and "1.4x" in another made the table
 * disagree with the figure directly above it.
 */
export function fmtMultiple(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n < 0) return "0";
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1);
}
