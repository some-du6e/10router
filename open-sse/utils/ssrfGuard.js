// SSRF guard: block internal/private/metadata targets for server-side fetch.
//
// Three layers, each closing a distinct bypass class documented in #3714:
//   1. assertPublicUrl        - synchronous literal-IP/hostname checks (cheap, for
//                                immediate rejection of obviously-bad input at request-build time).
//   2. assertPublicUrlResolved - adds DNS resolution so a hostname that merely
//                                *resolves* to a private/loopback address (e.g. a
//                                nip.io/sslip.io wildcard-DNS domain, or an attacker's
//                                own domain pointed at 127.0.0.1) is also rejected.
//   3. fetchPublic             - wraps fetch() with manual redirect handling so a
//                                validated public URL can't 30x its way to an
//                                internal target without the redirect target being
//                                re-validated through layer 2 first.
//
// Layer 1 alone previously had matching bugs, not just missing coverage: hostname
// checks ran on the raw string without normalizing a trailing dot ("localhost."),
// and the IPv6 check only recognized one textual representation of an IPv4-mapped
// address (dotted "::ffff:a.b.c.d") while Node/WHATWG URL parsing can normalize the
// same address to hex form ("::ffff:7f00:1") — a mismatch, not an oversight.

import dns from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { envProxyDispatcher } from "./envProxy.js";

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];

// Parse dotted IPv4 to 32-bit integer, or null if not a valid IPv4 literal.
function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

// Private/reserved IPv4 ranges as [startInt, maskBits].
const BLOCKED_V4_RANGES = [
  [ipv4ToInt("0.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("100.64.0.0"), 10], // CGNAT — also used by some cloud metadata proxies
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16], // includes 169.254.169.254 cloud metadata
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("192.0.0.0"), 24], // IETF protocol assignments (incl. DS-Lite 192.0.0.0/29)
  // Not 198.18.0.0/15 (benchmarking): Clash, mihomo, sing-box and Surge TUN
  // "fake-IP" modes answer every DNS lookup from it, so blocking it would block
  // every hostname on those machines.
];

function isBlockedIpv4Int(ip) {
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return isBlockedIpv4Int(ip);
}

function parseHextets(s) {
  if (s === "") return [];
  const segs = s.split(":");
  const out = [];
  for (const seg of segs) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    out.push(parseInt(seg, 16));
  }
  return out;
}

// Parse any textual IPv6 representation (including an embedded dotted-IPv4 tail,
// "::" compression in any position, and full/partial forms) into 8 16-bit groups.
// Returns null if the string isn't a valid IPv6 literal. Parsing into groups once
// and reasoning about the numeric value — rather than pattern-matching the source
// string — is what makes this immune to "which textual form did the URL parser
// pick" bugs: "::ffff:127.0.0.1" and "::ffff:7f00:1" produce identical groups.
function parseIPv6ToGroups(rawHost) {
  let host = rawHost.toLowerCase();

  const v4TailMatch = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let v4Groups = null;
  if (v4TailMatch) {
    const v4Int = ipv4ToInt(v4TailMatch[1]);
    if (v4Int === null) return null;
    v4Groups = [(v4Int >>> 16) & 0xffff, v4Int & 0xffff];
    host = host.slice(0, host.length - v4TailMatch[1].length);
    if (host.endsWith("::")) {
      // "::" compression marker itself — leave both colons, the removed IPv4
      // fills the gap it represents.
    } else if (host.endsWith(":")) {
      host = host.slice(0, -1); // was just the "prevgroup:ipv4" separator
    }
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  let groups;
  if (doubleColonParts.length === 2) {
    const head = parseHextets(doubleColonParts[0]);
    const tail = parseHextets(doubleColonParts[1]);
    if (head === null || tail === null) return null;
    const v4Len = v4Groups ? v4Groups.length : 0;
    const missing = 8 - head.length - tail.length - v4Len;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail, ...(v4Groups || [])];
  } else {
    const all = parseHextets(host);
    if (all === null) return null;
    groups = [...all, ...(v4Groups || [])];
  }
  return groups.length === 8 ? groups : null;
}

function isBlockedIpv6Groups(g) {
  const isZero = (n) => g[n] === 0;
  // loopback ::1
  if ([0, 1, 2, 3, 4, 5, 6].every(isZero) && g[7] === 1) return true;
  // unspecified ::
  if (g.every((x) => x === 0)) return true;
  // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // unique local fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // IPv4-mapped ::ffff:0:0/96 (0:0:0:0:0:ffff:a.b.c.d — the 0xffff marker is
  // group index 5) and NAT64 well-known prefix 64:ff9b::/96 — both embed a
  // real IPv4 address in the low 32 bits; check it against the same IPv4
  // blocklist regardless of which prefix wraps it.
  // site-local fec0::/10 (deprecated, still routed on some internal networks)
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  const low32 = ((g[6] << 16) | g[7]) >>> 0;
  if ([0, 1, 2, 3, 4].every(isZero) && g[5] === 0xffff) return isBlockedIpv4Int(low32);
  // IPv4-translated ::ffff:0:a.b.c.d (SIIT, RFC 2765)
  if ([0, 1, 2, 3].every(isZero) && g[4] === 0xffff && g[5] === 0) return isBlockedIpv4Int(low32);
  if (g[0] === 0x0064 && g[1] === 0xff9b && [2, 3, 4, 5].every(isZero)) return isBlockedIpv4Int(low32);
  // NAT64 local-use 64:ff9b:1::/48 (RFC 8215): the v4 can sit anywhere in the
  // low bits depending on prefix length, so block the whole range.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;
  // 6to4 2002::/16: the embedded IPv4 is groups 1-2.
  if (g[0] === 0x2002) return isBlockedIpv4Int(((g[1] << 16) | g[2]) >>> 0);
  // IPv4-compatible ::a.b.c.d/96 (deprecated, still parseable) — excludes :: and ::1
  // which already matched above.
  if ([0, 1, 2, 3, 4, 5].every(isZero) && low32 !== 0 && low32 !== 1) return isBlockedIpv4Int(low32);
  return false;
}

function normalizeHost(hostname) {
  // A trailing dot marks an FQDN and is semantically insignificant
  // ("localhost." and "localhost" are the same host) but was being compared
  // as a literal character, letting it slip past every string-based check.
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isBlockedHost(host) {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (isBlockedIpv4(host)) return true;
  if (host.includes(":")) {
    const groups = parseIPv6ToGroups(host.replace(/^\[|\]$/g, ""));
    if (groups && isBlockedIpv6Groups(groups)) return true;
  }
  return false;
}

// True if a resolved IPv4/IPv6 address is internal, by the same rules as the URL checks.
export function isBlockedIpAddress(address) {
  if (typeof address !== "string" || !address) return true;
  return isBlockedHost(normalizeHost(address));
}

// Throw if URL targets a non-public host by literal hostname/IP alone (no DNS
// resolution — see assertPublicUrlResolved for that). Caller should map to 400.
export function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host)) throw new Error("Blocked URL: internal host");
}

// Async: assertPublicUrl plus DNS resolution of non-literal hostnames, so a
// domain that merely *resolves* to a private/loopback/metadata address (wildcard-DNS
// services like nip.io/sslip.io, or an attacker-controlled domain with an A record
// pointed at 127.0.0.1) is rejected too, not just IPs typed directly into the URL.
export async function assertPublicUrlResolved(rawUrl) {
  try {
    await resolvePublicAddresses(rawUrl);
  } catch (error) {
    // Resolution failure isn't an SSRF signal by itself — let the subsequent
    // fetch() fail with its own (clearer) network error. Fetches that must not
    // fail open use resolvePublicAddresses (fetchPublicHop, probeFetch).
    if (isBlockedUrlError(error)) throw error;
  }
}

// Every refusal from this guard starts with "Blocked URL".
export function isBlockedUrlError(error) {
  return String(error?.message || "").startsWith("Blocked URL");
}

// Check a URL and resolve its host once. Returns the addresses to connect to,
// or null for a literal IP (nothing to resolve, nothing to rebind). Throws a
// "Blocked URL" error for an internal host or address, and the lookup's own
// error when the name doesn't resolve: callers that connect fail closed.
export async function resolvePublicAddresses(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = normalizeHost(parsed.hostname);
  if (isBlockedHost(host)) throw new Error("Blocked URL: internal host");
  const bracketless = host.replace(/^\[|\]$/g, "");
  if (ipv4ToInt(bracketless) !== null || bracketless.includes(":")) return null;
  const addresses = await dns.promises.lookup(bracketless, { all: true, verbatim: true });
  if (!addresses?.length) throw new Error(`Host ${bracketless} did not resolve`);
  if (addresses.some((a) => isBlockedIpAddress(a.address))) {
    throw new Error("Blocked URL: hostname resolves to an internal host");
  }
  return addresses;
}

// A dispatcher whose connect uses exactly these addresses, so a DNS-rebinding
// host can't answer the check with a public IP and the connect with 127.0.0.1.
export function pinnedAgent(addresses) {
  const lookup = (_host, opts, cb) => (opts?.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family));
  return new Agent({ connect: { lookup } });
}

// One request to a public URL, redirects never followed. The URL is checked
// and resolved once (failing closed). When the environment's proxy covers it
// (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, NO_PROXY respected), the request goes
// through that proxy: the proxy resolves the name again, so the pin can't
// apply there. Otherwise the connection is pinned to the checked addresses.
// undici's own fetch, so the global fetch patch can't swap the dispatcher.
export async function fetchPublicHop(url, init = {}) {
  const addresses = await resolvePublicAddresses(url);
  const proxy = envProxyDispatcher(url);
  const pinned = !proxy && addresses ? pinnedAgent(addresses) : null;
  const dispatcher = proxy || pinned;
  try {
    return await undiciFetch(url, { ...init, redirect: "manual", ...(dispatcher ? { dispatcher } : {}) });
  } finally {
    // The body is read by the caller; closing gracefully waits for it.
    pinned?.close().catch(() => {});
  }
}

// fetch() with SSRF-safe manual redirect handling: each hop's target is
// re-validated before being followed, so a validated public URL can't 30x its
// way to an internal target. Bounded to maxRedirects hops. With `pin` (for a
// URL a client supplied), every hop goes through fetchPublicHop: resolved once,
// refused when it doesn't resolve, and pinned. Without it (operator-set URLs)
// the global fetch runs it, after the same check.
export async function fetchPublic(url, init = {}, { maxRedirects = 5, pin = false } = {}) {
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    let res;
    if (pin) {
      res = await fetchPublicHop(currentUrl, init);
    } else {
      await assertPublicUrlResolved(currentUrl);
      res = await fetch(currentUrl, { ...init, redirect: "manual" });
    }
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = isRedirect ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error("Blocked URL: too many redirects");
    await res.body?.cancel().catch(() => {});
    currentUrl = new URL(location, currentUrl).toString();
  }
}
