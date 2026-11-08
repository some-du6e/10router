// In-memory progressive lockout for dashboard login. Resets on process restart.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

// Across every key: the per-IP key is only as good as the proxy in front, so a
// client that can rotate it still hits this ceiling.
const GLOBAL_MAX_FAILS = 30;
const GLOBAL_WINDOW_MS = 10 * 60 * 1000;

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt, inFlight }
let globalFails = []; // timestamps of recent failures, oldest first

function now() { return Date.now(); }

function getEntry(ip) {
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLock(ip) {
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

function globalRetryAfter() {
  const cutoff = now() - GLOBAL_WINDOW_MS;
  globalFails = globalFails.filter((t) => t > cutoff);
  if (globalFails.length < GLOBAL_MAX_FAILS) return 0;
  return Math.max(1, Math.ceil((globalFails[0] - cutoff) / 1000));
}

/**
 * Claim one password attempt before any await. Concurrent attempts count against
 * the lockout while they are in flight, so a burst cannot outrun it. Pair every
 * successful reservation with releaseAttempt().
 */
export function reserveAttempt(ip) {
  const lock = checkLock(ip);
  if (lock.locked) return { ok: false, retryAfter: lock.retryAfter };
  const globalWait = globalRetryAfter();
  if (globalWait) return { ok: false, retryAfter: globalWait };
  const e = getEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0, inFlight: 0 };
  if (e.fails + (e.inFlight || 0) >= MAX_FAILS_BEFORE_LOCK) return { ok: false, retryAfter: 1 };
  e.inFlight = (e.inFlight || 0) + 1;
  attempts.set(ip, e);
  return { ok: true };
}

export function releaseAttempt(ip) {
  const e = attempts.get(ip);
  if (e && e.inFlight) e.inFlight -= 1;
}

export function recordFail(ip) {
  globalFails.push(now());
  const e = getEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0, inFlight: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  attempts.set(ip, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip) {
  const e = attempts.get(ip);
  // A lock that concurrent failures set while this attempt was in flight stands.
  if (e && e.lockUntil > now()) return;
  if (e && e.inFlight > 1) {
    attempts.set(ip, { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0, inFlight: e.inFlight });
    return;
  }
  attempts.delete(ip);
}

export function __resetLoginLimiterForTests() {
  attempts.clear();
  globalFails = [];
}

export function getClientIp(request) {
  // Trusted only when custom-server.js proves it stamped the header from the TCP socket;
  // otherwise a client could rotate the value to escape its own lockout bucket.
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return realIp;
  }
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // Direct exposure without custom-server: single bucket so spoofed XFF
  // rotation cannot escape the limiter.
  return "unknown";
}
