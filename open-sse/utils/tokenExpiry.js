/**
 * An expiry timestamp in ISO form, or null when it isn't a date.
 * @param {unknown} expiresAt
 * @returns {string|null}
 */
export function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * ISO expiry for a token that lives `expiresIn` seconds from `nowMs`.
 * Returns null when expiresIn isn't a positive number of seconds (a provider
 * can send a string or nothing), so a bad value never throws.
 * @param {unknown} expiresIn
 * @param {number} [nowMs]
 * @returns {string|null}
 */
export function expiresAtFromNow(expiresIn, nowMs = Date.now()) {
  if (expiresIn === null || expiresIn === undefined || expiresIn === "") return null;
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(nowMs + seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
