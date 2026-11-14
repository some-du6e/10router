import { HEADERS_TIMEOUT } from "../config/errorConfig.js";
import { UPSTREAM_STREAM_HEADERS_TIMEOUT_MS } from "../config/runtimeConfig.js";

// Streaming header timeouts per provider/model (HEADERS_TIMEOUT): the distinct
// requests and keys that hit one since the model last served, and whether that
// made it hung. In memory, per process.
// "provider|model" → { requests: Set, keys: Set, lastAt, reason,
//   hung: null | { level, until, reason, stalled: Set<connectionId>, probe: null | { id, at } } }
const models = (global._modelHang ??= new Map());
const MAX_MODELS = 10 * 1000;

const keyOf = (provider, model) => `${provider}|${model}`;
const windowMs = (level) => HEADERS_TIMEOUT.hungWindowMs[Math.min(level, HEADERS_TIMEOUT.hungWindowMs.length - 1)];
// Enough request ids to tell the threshold apart; more add nothing. (Keys are
// few, and all of them are kept as the hang's stalled keys.)
const addCapped = (set, value, cap) => { if (set.size < cap) set.add(value); };

/**
 * May this request call the upstream for this model? A hung model blocks every
 * request until its window ends, then lets one through as the probe.
 * @returns {{ blocked: false, probe: boolean, avoidKeys: string[] }
 *   | { blocked: true, checking: boolean, retryAtMs: number, reason: string }}
 *   avoidKeys: keys to try last: those whose stream timed out since the model
 *   last served (or, for the probe, during the hang). A second request then
 *   reaches another key, which tells a hung model from one slow key.
 *   checking: a probe is running; retryAtMs is when its stream budget runs out.
 */
export function checkModelHang(provider, model, requestId, now = Date.now()) {
  const entry = models.get(keyOf(provider, model));
  const hung = entry?.hung;
  if (!hung) {
    const recent = entry && now - entry.lastAt <= HEADERS_TIMEOUT.resetAfterMs;
    return { blocked: false, probe: false, avoidKeys: recent ? [...entry.keys] : [] };
  }
  const probe = () => ({ blocked: false, probe: true, avoidKeys: [...hung.stalled] });
  if (hung.probe?.id === requestId) return probe();
  if (now < hung.until) return { blocked: true, checking: false, retryAtMs: hung.until, reason: hung.reason };
  if (hung.probe && now - hung.probe.at < HEADERS_TIMEOUT.probeLeaseMs) {
    return { blocked: true, checking: true, retryAtMs: Math.max(now + 1000, hung.probe.at + UPSTREAM_STREAM_HEADERS_TIMEOUT_MS), reason: hung.reason };
  }
  hung.probe = { id: requestId, at: now };
  return probe();
}

/**
 * This request got no response headers from the model on this key. Only a
 * streaming call's timeout counts. Only the probe's moves a hung model to its
 * next window; one from a request sent before it was found hung changes nothing.
 * @returns {{ hung: boolean, retryAtMs: number | null }}
 */
export function noteHeadersTimeout(provider, model, { requestId, connectionId, stream, reason = "" }, now = Date.now()) {
  const key = keyOf(provider, model);
  let entry = models.get(key);
  const result = () => ({ hung: !!entry?.hung, retryAtMs: entry?.hung?.until ?? null });
  if (!stream) return result();
  if (entry?.hung) {
    const { hung } = entry;
    hung.stalled.add(connectionId);
    if (hung.probe?.id === requestId) {
      const level = now - hung.until > HEADERS_TIMEOUT.resetAfterMs ? 0 : hung.level + 1;
      entry.hung = { ...hung, level, until: now + windowMs(level), reason: reason || hung.reason, probe: null };
    }
    return result();
  }
  if (!entry || now - entry.lastAt > HEADERS_TIMEOUT.resetAfterMs) {
    if (!entry && models.size >= MAX_MODELS) models.clear();
    entry = { requests: new Set(), keys: new Set(), lastAt: now, reason, hung: null };
    models.set(key, entry);
  }
  entry.lastAt = now;
  entry.reason = reason || entry.reason;
  addCapped(entry.requests, requestId, HEADERS_TIMEOUT.hungAfterRequests);
  entry.keys.add(connectionId);
  if (entry.requests.size >= HEADERS_TIMEOUT.hungAfterRequests && entry.keys.size >= HEADERS_TIMEOUT.hungAfterKeys) {
    entry.hung = { level: 0, until: now + windowMs(0), reason: entry.reason, stalled: new Set(entry.keys), probe: null };
    entry.requests.clear();
    entry.keys.clear();
  }
  return result();
}

/** The model served a request: it isn't hung, and earlier header timeouts stop counting. */
export function noteModelServed(provider, model) {
  models.delete(keyOf(provider, model));
}

/** The probe ended some other way (another error, a hang-up): the next request probes. */
export function releaseProbe(provider, model, requestId) {
  const hung = models.get(keyOf(provider, model))?.hung;
  if (hung?.probe?.id === requestId) hung.probe = null;
}

export function clearModelHang() {
  models.clear();
}
