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

type Table = Map<string, Entry>;

// Logins with one key, and logins with two (see getClientKeys). One of a
// two-key login's keys is a header the client wrote, so its failures go in
// their own table: a client sending someone else's address as that header
// locks that address for two-key logins only, never for its owner's ordinary
// one-key logins. A two-key login is refused while either key is locked in
// either table, so rotating the free header still runs into the fixed key's
// locks: 5 guesses per lock as a two-key login, 5 more without the free header.
const attempts: Table = new Map();
const pairAttempts: Table = new Map();

function now(): number {
  return Date.now();
}

function newEntry(): Entry {
  return { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0, inFlight: 0 };
}

function getEntry(table: Table, key: string): Entry | null {
  const e = table.get(key);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    table.delete(key);
    return null;
  }
  return e;
}

/**
 * One key, or several for one login (see getClientKeys): a login counts against
 * every one of its keys and is refused while any of them is locked.
 */
export type Keys = string | readonly string[];

function keyList(keys: Keys): string[] {
  return [...new Set(typeof keys === "string" ? [keys] : keys)];
}

// The table a login's attempts and failures are counted in.
function tableFor(list: readonly string[]): Table {
  return list.length > 1 ? pairAttempts : attempts;
}

export function checkLock(keys: Keys): LockState {
  const list = keyList(keys);
  // A one-key login answers only to one-key locks; a two-key login to both.
  const tables = list.length > 1 ? [attempts, pairAttempts] : [attempts];
  let retryAfter = 0;
  for (const table of tables) {
    for (const key of list) {
      const e = getEntry(table, key);
      const remaining = e && e.lockUntil ? e.lockUntil - now() : 0;
      if (remaining > 0) retryAfter = Math.max(retryAfter, Math.ceil(remaining / 1000));
    }
  }
  return retryAfter ? { locked: true, retryAfter } : { locked: false };
}

/**
 * Claim one password attempt before any await. Concurrent attempts count against
 * the lockout while they are in flight, so a burst cannot outrun it. Pair every
 * successful reservation with releaseAttempt() on the same keys.
 */
export function reserveAttempt(keys: Keys): Reservation {
  const lock = checkLock(keys);
  if (lock.locked) return { ok: false, retryAfter: lock.retryAfter };
  const list = keyList(keys);
  const table = tableFor(list);
  const entries = list.map((key) => getEntry(table, key) ?? newEntry());
  if (entries.some((e) => e.fails + e.inFlight >= MAX_FAILS_BEFORE_LOCK)) return { ok: false, retryAfter: 1 };
  entries.forEach((e, i) => {
    e.inFlight += 1;
    table.set(list[i], e);
  });
  return { ok: true };
}

export function releaseAttempt(keys: Keys): void {
  const list = keyList(keys);
  const table = tableFor(list);
  for (const key of list) {
    const e = table.get(key);
    if (!e || !e.inFlight) continue;
    e.inFlight -= 1;
    // Nothing left to remember: don't keep one entry per address that ever tried.
    if (!e.inFlight && !e.fails && !e.lockUntil && !e.lockLevel) table.delete(key);
  }
}

export function recordFail(keys: Keys): { remainingBeforeLock: number } {
  const list = keyList(keys);
  const table = tableFor(list);
  let remainingBeforeLock = MAX_FAILS_BEFORE_LOCK;
  for (const key of list) {
    const e = getEntry(table, key) ?? newEntry();
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
    table.set(key, e);
    remainingBeforeLock = Math.min(remainingBeforeLock, Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails));
  }
  return { remainingBeforeLock };
}

export function recordSuccess(keys: Keys): void {
  const list = keyList(keys);
  const table = tableFor(list);
  for (const key of list) {
    const e = table.get(key);
    if (!e) continue;
    // A lock that concurrent failures set while this attempt was in flight stands.
    if (e.lockUntil > now()) continue;
    // Other attempts still hold reservations on this entry: clear its history, keep the count.
    if (e.inFlight > 1) {
      Object.assign(e, { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 });
      continue;
    }
    table.delete(key);
  }
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
 * address it chose (the socket, or what a proxy in front reported; see
 * clientKeysFor there) and proves it with the peer token. Without that proof (a
 * bare `next start` or `next dev`) no header can be trusted, so every request
 * shares SHARED_LOGIN_KEY and rotating a header can't escape the limiter. The
 * password login route keys a client on this machine on LOCAL_LOGIN_KEY instead.
 */
export function getClientIp(request: Request): string {
  return getClientKeys(request)[0];
}

/**
 * Every key a password login counts against: x-9r-real-ip, plus x-9r-alt-ips
 * when a proxy sent both X-Forwarded-For and X-Real-IP and either could be the
 * one the client wrote.
 */
export function getClientKeys(request: Request): string[] {
  if (!hasTrustedPeerHeaders(request)) return [SHARED_LOGIN_KEY];
  const realIp = request.headers.get("x-9r-real-ip");
  if (!realIp) return [SHARED_LOGIN_KEY];
  const alt = (request.headers.get("x-9r-alt-ips") || "").split(",").map((value) => value.trim()).filter(Boolean);
  return [...new Set([realIp, ...alt].map(limiterKeyFor))];
}

export const __test__ = {
  reset(): void {
    attempts.clear();
    pairAttempts.clear();
  },
  size(): number {
    return attempts.size + pairAttempts.size;
  },
};
