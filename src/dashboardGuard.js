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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback.
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

export function isLocalRequest(request) {
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-9r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
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
  // Browser on host: loopback Host + Origin (blocks tunnel/CSRF) + auth (JWT or requireLogin=false)
  if (isLocalRequest(request) && await isAuthenticated(request)) return true;
  return false;
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
  if (settings && settings.requireLogin === false) return !(await needsSetup(settings));
  return false;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const __test__ = {
  isLocalRequest,
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
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
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
