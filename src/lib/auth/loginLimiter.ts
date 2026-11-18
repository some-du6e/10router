// In-memory progressive lockout for dashboard login. Resets on process restart.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

type Entry = { fails: number; lockUntil: number; lockLevel: number; lastFailAt: number; inFlight: number };
type AttemptOptions = { local?: boolean };
export type Reservation = { ok: true } | { ok: false; retryAfter: number };
export type LockState = { locked: false } | { locked: true; retryAfter: number };

const attempts = new Map<string, Entry>();

function now(): number {
  return Date.now();
}

function newEntry(): Entry {
  return { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0, inFlight: 0 };
}

function getEntry(ip: string): Entry | null {
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLock(ip: string): LockState {
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

/**
 * Claim one password attempt before any await. Concurrent attempts count against
 * the lockout while they are in flight, so a burst cannot outrun it. Pair every
 * successful reservation with releaseAttempt().
 *
 * A login from this machine (`local`) is never limited, and that is decided
 * before any lock is read: whatever a remote client does to any bucket, the
 * owner can still log in here. Anyone on this machine can reset the password
 * from the CLI anyway.
 */
export function reserveAttempt(ip: string, { local = false }: AttemptOptions = {}): Reservation {
  if (local) return { ok: true };
  const lock = checkLock(ip);
  if (lock.locked) return { ok: false, retryAfter: lock.retryAfter };
  const e = getEntry(ip) ?? newEntry();
  if (e.fails + e.inFlight >= MAX_FAILS_BEFORE_LOCK) return { ok: false, retryAfter: 1 };
  e.inFlight += 1;
  attempts.set(ip, e);
  return { ok: true };
}

export function releaseAttempt(ip: string, { local = false }: AttemptOptions = {}): void {
  if (local) return;
  const e = attempts.get(ip);
  if (!e || !e.inFlight) return;
  e.inFlight -= 1;
  // Nothing left to remember: don't keep one entry per address that ever tried.
  if (!e.inFlight && !e.fails && !e.lockUntil && !e.lockLevel) attempts.delete(ip);
}

export function recordFail(ip: string, { local = false }: AttemptOptions = {}): { remainingBeforeLock: number } {
  if (local) return { remainingBeforeLock: MAX_FAILS_BEFORE_LOCK };
  const e = getEntry(ip) ?? newEntry();
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

export function recordSuccess(ip: string): void {
  const e = attempts.get(ip);
  if (!e) return;
  // A lock that concurrent failures set while this attempt was in flight stands.
  if (e.lockUntil > now()) return;
  // Other attempts still hold reservations on this entry: clear its history, keep the count.
  if (e.inFlight > 1) {
    Object.assign(e, { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 });
    return;
  }
  attempts.delete(ip);
}

/**
 * The address to key a login on. custom-server.js stamps x-9r-real-ip with the
 * address it chose (the socket, or the hop a proxy on this machine appended; see
 * clientIpFor there) and proves it with the peer token. Without that proof (a
 * bare `next start` or `next dev`) no header can be trusted, so every request
 * shares one bucket and rotating a header can't escape the limiter.
 */
export function getClientIp(request: Request): string {
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return realIp;
  }
  return "unknown";
}

export const __test__ = {
  reset(): void {
    attempts.clear();
  },
  size(): number {
    return attempts.size;
  },
};
