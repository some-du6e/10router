import { getSettings } from "@/lib/localDb";

// Which base URLs a credential already on this host may go to. Two uses:
// - mayKeepStoredKey: a card sends KEEP_EXISTING_KEY (keepKey.js) when it can't
//   show the key stored in a tool's config. Keeping it is only safe when the key
//   still goes where it went before: the same base URL, or one of this instance's
//   own endpoints.
// - checkNewBaseUrl: any settings route writing a base URL the request picked
//   makes sure the tool won't fall back to, or carry along, a credential stored
//   on this host for a URL that is neither.
// Otherwise a remote dashboard session could repoint a tool and have the user's
// credentials sent to a host it chose.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

function parse(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

// Origin plus path, without trailing slashes or a trailing /v1, lowercased:
// "http://localhost:20128/v1/" and "http://LOCALHOST:20128" compare equal.
export function normalizeBaseUrl(url) {
  const parsed = parse(url);
  if (!parsed) return null;
  const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`.toLowerCase();
}

export function isSameBaseUrl(a, b) {
  const left = normalizeBaseUrl(a);
  return !!left && left === normalizeBaseUrl(b);
}

// The public URLs this instance is reachable at: its Cloudflare tunnel, Tailscale
// URL and configured cloud/base URL. Never the request's Host header, which the
// caller controls. tailscaleUrl and tunnelUrl are written only by the Tailscale and
// tunnel managers (PATCH /api/settings refuses them), and only count while the
// manager has them enabled.
async function ownOrigins() {
  const urls = [process.env.NEXT_PUBLIC_CLOUD_URL, process.env.NEXT_PUBLIC_BASE_URL];
  try {
    const settings = await getSettings();
    if (settings?.tailscaleEnabled === true) urls.push(settings.tailscaleUrl);
  } catch { /* no settings: loopback only */ }
  try {
    const { getTunnelStatus } = await import("@/lib/tunnel/cloudflare/manager.js");
    const tunnel = await getTunnelStatus();
    // URLs from the tunnel manager's state file; trusted only while
    // settings.tunnelEnabled, which only the manager writes, is true.
    if (tunnel?.settingsEnabled === true) urls.push(tunnel.publicUrl, tunnel.tunnelUrl);
  } catch { /* no tunnel */ }
  return new Set(urls.map((u) => parse(u)?.origin?.toLowerCase()).filter(Boolean));
}

export async function isOwnEndpoint(url) {
  const parsed = parse(url);
  if (!parsed) return false;
  if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return true;
  return (await ownOrigins()).has(parsed.origin.toLowerCase());
}

// Whether a stored key may stay in place for a config now pointing at newBaseUrl.
export async function mayKeepStoredKey(newBaseUrl, storedBaseUrl) {
  if (storedBaseUrl && isSameBaseUrl(newBaseUrl, storedBaseUrl)) return true;
  return await isOwnEndpoint(newBaseUrl);
}

export const CHOOSE_A_KEY_ERROR = "The stored API key only stays for the same base URL or this 10router; choose a key";

// A key a request may hand a tool: a string with something besides whitespace.
export const isCredential = (value) => typeof value === "string" && value.trim() !== "";

// Run by the settings routes whose tool could otherwise use a credential the
// route doesn't replace (Codex, Hermes, Claude Code, OpenCode, Cline) before they
// write a base URL. A tool pointed somewhere new keeps using that credential, so
// for a base URL that is neither storedBaseUrl nor this instance
// (mayKeepStoredKey false) the write may only go ahead when:
// - no credential the route leaves in place would go along (otherCredentials:
//   names of stored entries, given in the error), and
// - when the tool falls back to a host credential without a key (fallback: what
//   it would use), the request brings its own key (credential), which the route
//   then writes so that the tool uses it instead.
// Pass storedBaseUrl only when the stored credential really went there before:
// a route that rewrites the credential's entry vouches for nothing.
// Returns { foreign, error }: foreign tells the route to write the request's
// credential in place of the host's; error is the 400 message, or null.
export async function checkNewBaseUrl({ tool, baseUrl, storedBaseUrl = null, credential, fallback = null, otherCredentials = [], where }) {
  if (await mayKeepStoredKey(baseUrl, storedBaseUrl)) return { foreign: false, error: null };
  if (otherCredentials.length) {
    return {
      foreign: true,
      error: `${where} has ${otherCredentials.join(" and ")}; remove it or point ${tool} back at this instance`,
    };
  }
  if (fallback && !isCredential(credential)) {
    const target = parse(baseUrl)?.origin || "that base URL";
    const notOurs = storedBaseUrl ? "is neither its current base URL nor this 10router" : "isn't this 10router";
    return {
      foreign: true,
      error: `${tool} would send ${fallback} to ${target}, which ${notOurs}; choose a key for it`,
    };
  }
  return { foreign: true, error: null };
}
