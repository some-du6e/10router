// In-memory progressive lockout for dashboard login. Resets on process restart.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

/** The key for every password login from a client on this machine. */
export const LOCAL_LOGIN_KEY = "local";
/**
 * The key for every login whose address isn't known: no custom-server.js in
 * front (a bare `next start`), or a proxy that sent no usable address. Many
 * clients share it, so it locks for a short fixed time and never escalates:
 * one client failing on purpose can hold the others out for at most that long.
 */
export const SHARED_LOGIN_KEY = "unknown";
const SHARED_LOCK_MS = 15_000;

type Entry = { fails: number; lockUntil: number; lockLevel: number; lastFailAt: number; inFlight: number };
export type Reservation = { ok: true } | { ok: false; retryAfter: number };
export type LockState = { locked: false } | { locked: true; retryAfter: number };

const attempts = new Map<string, Entry>();

function now(): number {
  return Date.now();
}

function newEntry(): Entry {
  return { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0, inFlight: 0 };
}

function getEntry(key: string): Entry | null {
  const e = attempts.get(key);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(key);
    return null;
  }
  return e;
}

export function checkLock(key: string): LockState {
  const e = getEntry(key);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

/**
 * Claim one password attempt before any await. Concurrent attempts count against
 * the lockout while they are in flight, so a burst cannot outrun it. Pair every
 * successful reservation with releaseAttempt().
 */
export function reserveAttempt(key: string): Reservation {
  const lock = checkLock(key);
  if (lock.locked) return { ok: false, retryAfter: lock.retryAfter };
  const e = getEntry(key) ?? newEntry();
  if (e.fails + e.inFlight >= MAX_FAILS_BEFORE_LOCK) return { ok: false, retryAfter: 1 };
  e.inFlight += 1;
  attempts.set(key, e);
  return { ok: true };
}

export function releaseAttempt(key: string): void {
  const e = attempts.get(key);
  if (!e || !e.inFlight) return;
  e.inFlight -= 1;
  // Nothing left to remember: don't keep one entry per address that ever tried.
  if (!e.inFlight && !e.fails && !e.lockUntil && !e.lockLevel) attempts.delete(key);
}

export function recordFail(key: string): { remainingBeforeLock: number } {
  const e = getEntry(key) ?? newEntry();
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    if (key === SHARED_LOGIN_KEY) {
      e.lockUntil = now() + SHARED_LOCK_MS;
    } else {
      e.lockUntil = now() + LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
      e.lockLevel += 1;
    }
    e.fails = 0;
  }
  attempts.set(key, e);
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(key: string): void {
  const e = attempts.get(key);
  if (!e) return;
  // A lock that concurrent failures set while this attempt was in flight stands.
  if (e.lockUntil > now()) return;
  // Other attempts still hold reservations on this entry: clear its history, keep the count.
  if (e.inFlight > 1) {
    Object.assign(e, { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 });
    return;
  }
  attempts.delete(key);
}

// The eight 16-bit groups of an IPv6 address, or null.
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const groups = parts.map((part) => (/^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

/**
 * The limiter key for one address. An IPv6 client usually holds a whole /64, so
 * it is keyed on that prefix; an IPv4-mapped address is keyed as the IPv4 one.
 */
export function limiterKeyFor(address: string): string {
  if (!address.includes(":")) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * The key to limit a login on. custom-server.js stamps x-9r-real-ip with the
 * address it chose (the socket, or the hop a proxy on this machine appended; see
 * clientIpFor there) and proves it with the peer token. Without that proof (a
 * bare `next start` or `next dev`) no header can be trusted, so every request
 * shares SHARED_LOGIN_KEY and rotating a header can't escape the limiter. The
 * login route keys a client on this machine on LOCAL_LOGIN_KEY instead.
 */
export function getClientIp(request: Request): string {
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return limiterKeyFor(realIp);
  }
  return SHARED_LOGIN_KEY;
}

export const __test__ = {
  reset(): void {
    attempts.clear();
  },
  size(): number {
    return attempts.size;
  },
};
