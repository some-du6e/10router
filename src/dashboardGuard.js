import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { CLI_TOKEN_HEADER, isValidCliToken } from "@/lib/auth/cliToken.js";
import { verifyDashboardAuthToken, getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { needsSetup } from "@/lib/auth/setupState";
import { acceptsDashboardSession, getConfiguredSsoType } from "@/lib/auth/authMode.js";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import { extractClientApiKey } from "@/shared/utils/clientApiKey.js";
import { containsManagementKey } from "@/shared/utils/managementKey.js";
import { isManagementApiPath, authenticateManagementKey } from "@/lib/management/auth.js";

async function hasValidCliToken(request) {
  return await isValidCliToken(request.headers.get(CLI_TOKEN_HEADER));
}

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/change-password",
  // The SSO sign-in itself. The settings test routes (/api/auth/oidc/test,
  // /api/auth/saml/test) are dashboard APIs and stay behind the session check.
  "/api/auth/oidc/start",
  "/api/auth/oidc/callback",
  "/api/auth/saml/start",
  "/api/auth/saml/acs",
  "/api/auth/saml/metadata",
  "/api/version",
  "/api/settings/require-login",
];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
// Keep root-level rewrites here too: middleware runs before Next.js rewrites.
// Every source of a next.config.mjs rewrite to /api/v1* belongs here; the
// guard test checks that against the config.
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses", "/systemone", "/backend-api"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
];

// Require auth, but allow through if requireLogin is disabled
const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers",
  "/api/provider-nodes",
  "/api/proxy-pools",
  "/api/combos",
  "/api/models",
  "/api/usage",
  "/api/oauth",
  "/api/cloud",
  "/api/media-providers",
  "/api/pricing",
  "/api/tags",
  "/api/cli-tools",
  "/api/mcp",
  "/api/translator",
  "/api/tunnel",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/auth/reset-password",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback. Same rule as
// isLoopbackHost in custom-server.js (which can't import from src/); the parity table
// in tests/unit/dashboard-guard.test.js holds them together.
function isLoopbackHostname(h) {
  if (!h) return false;
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return false;
    name = name.slice(1, end);
  } else if (name.indexOf(":") !== -1 && name.indexOf(":") === name.lastIndexOf(":")) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7);
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-9r-real-ip"));
  }
  // Bare `next dev` forks its server, so the wrapper never loads and no peer address
  // reaches us. Host is spoofable, so this stays confined to development.
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

// A browser request another site started (link, <img>, form, fetch). Browsers send no
// Origin on cross-site GETs, so this is the only header that tells them apart.
function isCrossSiteBrowserRequest(request) {
  const site = request.headers.get("sec-fetch-site");
  return !!site && site !== "same-origin" && site !== "none";
}

// The Host the browser used, as a URL (scheme from Origin), or null.
function hostUrl(host, protocol) {
  if (!host || !host.trim()) return null;
  try {
    return new URL(`${protocol}//${host.trim()}`);
  } catch {
    return null;
  }
}

// Same host name, and the same port unless Host carries none (nginx's $host drops
// it). Default ports compare equal, since URL drops them.
function originMatchesHost(originUrl, host) {
  const target = hostUrl(host, originUrl.protocol);
  if (!target || target.hostname.replace(/\.$/, "") !== originUrl.hostname.replace(/\.$/, "")) return false;
  return !target.port || target.port === originUrl.port;
}

// A browser sends Origin on every cross-origin POST and fetch, plain HTTP included,
// where it sends no Sec-Fetch-Site. A request whose Origin isn't this server came
// from another page, so neither a session cookie nor requireLogin=false admits it.
// Sec-Fetch-Site: same-origin settles it first (it also covers `Origin: null` from a
// no-referrer page). Otherwise "this server" is the Host the browser used: the Host
// header, or X-Forwarded-Host from a proxy that rewrites Host (a page can't set that
// header on a cross-origin request without a CORS preflight, which is never granted).
function isOtherOriginBrowserRequest(request) {
  if (request.headers.get("sec-fetch-site") === "same-origin") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return true; // "null" (sandboxed frame, file://, no-referrer) or junk
  }
  const hosts = [request.headers.get("host"), (request.headers.get("x-forwarded-host") || "").split(",")[0]];
  return !hosts.some((host) => originMatchesHost(originUrl, host));
}

// Proof a browser request came from this server's own page: Sec-Fetch-Site
// same-origin (or none: typed, bookmarked), or an Origin that matches the Host. A
// GET from another page carries neither when the target isn't a secure context
// (http://0.0.0.0, a LAN address), so the absence of a cross-site marker isn't enough.
function hasSameOriginProof(request) {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  return !!request.headers.get("origin") && !isOtherOriginBrowserRequest(request);
}

function hostnameOf(value) {
  try {
    return value ? new URL(value).hostname.toLowerCase().replace(/\.$/, "") : "";
  } catch {
    return "";
  }
}

// The request came in on the Cloudflare tunnel or Tailscale URL. custom-server.js
// also stamps x-9r-via-tunnel on a loopback peer whose Host is a *.trycloudflare.com
// or *.ts.net name, so a stale stored URL can't let tunnel traffic in. A
// Cloudflare-proxied domain in front of a reverse proxy isn't tunnel traffic.
// A malformed stored URL matches nothing rather than throwing.
export function isTunnelHost(request, settings) {
  if (hasTrustedPeerHeaders(request) && request.headers.get("x-9r-via-tunnel")) return true;
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return [settings?.tunnelUrl, settings?.tailscaleUrl].some((url) => hostnameOf(url) === host);
}

// With login off, a page on any domain that resolves to this machine (DNS
// rebinding) would be same-origin with it. So the open dashboard API answers only
// Hosts that can't be rebound: loopback names, IP literals, and the hosts this
// install was given: the tunnel and Tailscale URLs, BASE_URL / NEXT_PUBLIC_BASE_URL,
// and ALLOWED_HOSTS (a comma list of host names or URLs, for an install reached
// by several names, such as a tunnel domain and a LAN name).
function allowedHostNames(settings) {
  const listed = String(process.env.ALLOWED_HOSTS || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return [settings?.tunnelUrl, settings?.tailscaleUrl, process.env.BASE_URL, process.env.NEXT_PUBLIC_BASE_URL, ...listed]
    .map((value) => (value && !String(value).includes("://") ? hostUrl(String(value), "http:")?.hostname.toLowerCase().replace(/\.$/, "") || "" : hostnameOf(value)))
    .filter(Boolean);
}

function isAllowedOpenHost(request, settings) {
  const raw = request.headers.get("host");
  if (!raw) return true;
  const url = hostUrl(raw, "http:");
  if (!url) return false;
  const name = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isLoopbackHostname(name)) return true;
  if (name.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  return allowedHostNames(settings).includes(name);
}

export function isLocalRequest(request) {
  // Stamped by custom-server.js on every request not from a client on this machine
  // (isOnThisMachine there): a loopback socket that is a proxy hop, not the end user.
  if (request.headers.get("x-9r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  // A cross-site request without Origin (a navigation or simple GET) can't be
  // told apart from a local tool by Origin, so Sec-Fetch-Site decides it.
  if (!origin && isCrossSiteBrowserRequest(request)) return false;
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch { return false; }
  }
  return true;
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const extractApiKey = extractClientApiKey;

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  // Browser on host: loopback peer + Origin (blocks tunnel/CSRF) + auth (JWT or requireLogin=false)
  if (!isLocalRequest(request)) return false;
  // These routes spawn processes or read host secrets, and a GET from another page
  // (<img>, EventSource) can reach one with no Origin and, on http://0.0.0.0, no
  // Sec-Fetch-Site either. Without the CLI token, a GET needs same-origin proof.
  if (isSafeMethod(request) && !hasSameOriginProof(request)) return false;
  return await isAuthenticated(request);
}

function isSafeMethod(request) {
  const method = String(request.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

// The only endpoints a restricted (forced-password-change) session may reach.
const PW_CHANGE_ALLOWED_PATHS = [
  "/api/auth/change-password",
  "/api/auth/logout",
  "/api/auth/status",
];

async function readSession(request) {
  return await getDashboardAuthSession(request.cookies.get("auth_token")?.value);
}

// A restricted session is deliberately NOT a valid token anywhere else: it is
// issued after a last login on the old default password and unlocks only the
// change-password endpoint.
//
// While setup is pending (after Reset Password, in any mode), only a session
// from the SSO protocol configured now counts, for pages and API alike: a
// password session from before the reset must not reach /api/settings and
// repoint SSO (acceptsDashboardSession). The CLI token and the setup routes
// don't go through here.
async function hasValidToken(request) {
  if (isOtherOriginBrowserRequest(request)) return false;
  const session = await readSession(request);
  if (!session || session.pwChange === true) return false;
  const settings = await loadSettings();
  return acceptsDashboardSession(session, settings, await needsSetup(settings));
}

async function hasRestrictedSession(request) {
  const session = await readSession(request);
  return !!session && session.pwChange === true;
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  // requireLogin=false is an opt-out for a *claimed* instance. An instance that
  // has never been set up must never be open, whatever the stored flag says.
  if (settings && settings.requireLogin === false) {
    if (isCrossSiteBrowserRequest(request) || isOtherOriginBrowserRequest(request)) return false;
    if (!isAllowedOpenHost(request, settings)) return false;
    return !(await needsSetup(settings));
  }
  return false;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const __test__ = {
  isLocalRequest,
  isLoopbackHostname,
  isOtherOriginBrowserRequest,
  hasSameOriginProof,
  isAllowedOpenHost,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
  isPublicApi,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // The management API takes a management key and nothing else: no session,
  // no CLI token, no requireLogin=false. It is the only place a management
  // key is accepted; everywhere below, one counts for nothing. The routes
  // authenticate it again to act as it.
  if (isManagementApiPath(pathname)) {
    const auth = await authenticateManagementKey(request);
    if (auth.ok) return NextResponse.next();
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // First-run gate: until someone claims the instance with the console setup
  // token, every dashboard/login page funnels to /setup. When a configured SSO
  // protocol is selected (after Reset Password with SSO on), /login and the
  // dashboard stay reachable, and the dashboard block below lets only an SSO
  // session in; /setup still takes the token.
  if (pathname === "/setup" || pathname.startsWith("/dashboard") || pathname === "/login" || pathname === "/") {
    const settings = await loadSettings();
    const setupPending = await needsSetup(settings);
    if (setupPending && pathname !== "/setup" && !getConfiguredSsoType(settings)) {
      return NextResponse.redirect(new URL("/setup", request.url));
    }
    if (!setupPending && pathname === "/setup") {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    if (pathname === "/setup") return NextResponse.next();
  }

  // Forced-password-change gate: a legacy session may only reach the endpoints
  // that complete the change. Everything else funnels back to /login, so the
  // change cannot be skipped by navigating straight to the dashboard.
  if (pathname.startsWith("/dashboard") || pathname === "/" || pathname.startsWith("/api/")) {
    if (!isPublicLlmApi(pathname) && await hasRestrictedSession(request)) {
      if (PW_CHANGE_ALLOWED_PATHS.includes(pathname)) return NextResponse.next();
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Password change required", mustChangePassword: true },
          { status: 403 }
        );
      }
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  if (pathname.startsWith("/api/") && !isPublicApi(pathname)) {
    const settings = await loadSettings();
    if (settings && settings.tunnelDashboardAccess !== true && isTunnelHost(request, settings)) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }
  }

  // Local-only gate for spawn-capable / host-secret routes.
  if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only: CLI token required" }, { status: 403 });
    }
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicLlmApi(pathname)) {
    // Refused even from loopback: a handler would otherwise record usage
    // against the presented token, writing the management secret to the log.
    // Anywhere in the token, so padding ("Bearer  10r-mgmt-…") can't slip one past.
    if (containsManagementKey(extractApiKey(request))) {
      return NextResponse.json({ error: "A management key can't be used for inference. Use a client API key." }, { status: 401 });
    }
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) return NextResponse.next();
    if (await hasValidCliToken(request) || await isAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;
    let setupPending = false;
    let settings = null;

    try {
      settings = await loadSettings();
      if (settings) {
        setupPending = await needsSetup(settings);
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess && isTunnelHost(request, settings)) {
          return NextResponse.redirect(new URL("/login", request.url));
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // Setup pending: the first-run gate only let this through for SSO sign-in,
    // so a session from the configured SSO is the only way in. requireLogin=false
    // never opens an unclaimed instance, and a session from before the reset
    // doesn't count.
    if (setupPending) {
      if (acceptsDashboardSession(await readSession(request), settings, true)) return NextResponse.next();
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // If login not required, allow through
    if (!requireLogin) return NextResponse.next();

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
