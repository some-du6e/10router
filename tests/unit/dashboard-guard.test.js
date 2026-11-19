import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  getDashboardAuthSession: vi.fn(),
  getMeta: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
  getDashboardAuthSession: mocks.getDashboardAuthSession,
}));

// setupState (pulled in by the guard) would otherwise touch the real DB/_meta.
vi.mock("@/lib/db/helpers/metaStore.js", () => ({
  getMeta: mocks.getMeta,
  setMeta: vi.fn(),
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: () => false,
}));

const { proxy, isTunnelHost, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

// The login-off Host allowlist reads these; every test starts with them unset.
beforeEach(() => {
  for (const name of ["BASE_URL", "NEXT_PUBLIC_BASE_URL", "ALLOWED_HOSTS", "TRUST_PROXY"]) vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function request(pathname, headers = {}, cookieValue = undefined) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => (cookieValue ? { value: cookieValue } : undefined)) },
    url: `http://localhost${pathname}`,
  };
}

// A request that actually came through custom-server.js: peer IP stamped from the TCP
// socket and proven by the per-process secret.
function localRequest(pathname, headers = {}) {
  return request(pathname, { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password: "$2a$10$storedhash" });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(localRequest("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(request("/codex/x", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote /responses rewrite without API key", async () => {
    const response = await proxy(request("/responses", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote /responses rewrite with a valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/responses", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/codex/x", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password: "$2a$10$storedhash" });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(localRequest("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, password: "$2a$10$storedhash" });

    const response = await proxy(localRequest("/api/tunnel/tailscale-install", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, password: "$2a$10$storedhash" });

    const response = await proxy(request("/api/tunnel/tailscale-install", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false, password: "$2a$10$storedhash" });

    const response = await proxy(localRequest("/api/tunnel/tailscale-install", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard first-run setup gate", () => {
  // No stored password hash and no legacy stamp → instance is unclaimed.
  const unclaimed = { requireLogin: true };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(unclaimed);
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });

  it("redirects the dashboard to /setup", async () => {
    const response = await proxy(request("/dashboard", { host: "localhost:20128" }));

    expect(response.status).toBe(307);
    expect(response.url.pathname).toBe("/setup");
  });

  it("redirects the login page to /setup", async () => {
    const response = await proxy(request("/login", { host: "localhost:20128" }));

    expect(response.status).toBe(307);
    expect(response.url.pathname).toBe("/setup");
  });

  it("serves /setup itself", async () => {
    const response = await proxy(request("/setup", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("does not let requireLogin=false open an unclaimed instance", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const page = await proxy(request("/dashboard", { host: "localhost:20128" }));
    expect(page.status).toBe(307);
    expect(page.url.pathname).toBe("/setup");

    const api = await proxy(request("/api/settings", { host: "localhost:20128" }));
    expect(api.status).toBe(401);
  });

  it("redirects /setup back to /login once a password is stored", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password: "$2a$10$storedhash" });

    const response = await proxy(request("/setup", { host: "localhost:20128" }));

    expect(response.status).toBe(307);
    expect(response.url.pathname).toBe("/login");
  });

  it("doesn't let a session from before a password-mode reset use the API", async () => {
    // Unclaimed (no hash, no SSO): what Reset Password leaves in password mode.
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    expect((await proxy(request("/api/settings", { host: "localhost:20128" }, "password-session"))).status).toBe(401);
    expect((await proxy(request("/api/settings/database", { host: "localhost:20128" }, "password-session"))).status).toBe(401);
    expect((await proxy(request("/api/auth/oidc/test", { host: "localhost:20128" }, "password-session"))).status).toBe(401);
  });

  it("lets a password session use the API and the SSO test routes once the instance is claimed", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password: "$2a$10$storedhash" });
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    expect(await proxy(request("/api/auth/oidc/test", { host: "localhost:20128" }, "password-session"))).toBe(mocks.nextResponse);
  });

  it("lets a password session use the API once the instance is claimed", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password: "$2a$10$storedhash" });
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });

    expect(await proxy(request("/api/settings", { host: "localhost:20128" }, "password-session"))).toBe(mocks.nextResponse);
  });

  it("keeps the legacy default-password install on the normal login page", async () => {
    mocks.getMeta.mockResolvedValue("1");

    const response = await proxy(request("/login", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
  });

  describe("after Reset Password in an SSO mode (Both, configured SSO, no password)", () => {
    const ssoDuringSetup = {
      requireLogin: true,
      authMode: "both",
      ssoType: "oidc",
      oidcIssuerUrl: "https://idp.example.test",
      oidcClientId: "client",
      oidcClientSecret: "secret",
    };
    beforeEach(() => mocks.getSettings.mockResolvedValue(ssoDuringSetup));

    it("keeps the login page, with its SSO button, reachable", async () => {
      expect(await proxy(request("/login", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    });

    it("(guard) still serves /setup for the token", async () => {
      expect(await proxy(request("/setup", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    });

    it("(guard) keeps the SSO routes public", async () => {
      expect(await proxy(request("/api/auth/oidc/start", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
      expect(await proxy(request("/api/auth/oidc/callback", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
      expect(await proxy(request("/api/auth/saml/acs", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    });

    it("opens the dashboard to an SSO-signed-in session and sends anyone else to /login", async () => {
      const anonymous = await proxy(request("/dashboard", { host: "localhost:20128" }));
      expect(anonymous.url.pathname).toBe("/login");

      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, oidc: true });
      expect(await proxy(request("/dashboard", { host: "localhost:20128" }, "sso-session"))).toBe(mocks.nextResponse);
    });

    it("takes only a session from the SSO protocol configured now", async () => {
      // OIDC is configured; a SAML session from before a switch doesn't count.
      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, saml: true });
      expect((await proxy(request("/dashboard", { host: "localhost:20128" }, "saml-session"))).url.pathname).toBe("/login");
      expect((await proxy(request("/api/settings", { host: "localhost:20128" }, "saml-session"))).status).toBe(401);

      // Switched to SAML (configured): now the OIDC session is the stale one.
      mocks.getSettings.mockResolvedValue({ ...ssoDuringSetup, ssoType: "saml", samlEntryPoint: "https://idp.example.test/sso", samlCert: "cert" });
      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, oidc: true });
      expect((await proxy(request("/api/settings", { host: "localhost:20128" }, "oidc-session"))).status).toBe(401);
      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, saml: true });
      expect(await proxy(request("/api/settings", { host: "localhost:20128" }, "saml-session"))).toBe(mocks.nextResponse);
    });

    it("keeps the SSO settings test routes behind the same rule", async () => {
      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
      for (const path of ["/api/auth/oidc/test", "/api/auth/saml/test"]) {
        expect((await proxy(request(path, { host: "localhost:20128" }, "password-session"))).status, path).toBe(401);
      }
      mocks.getDashboardAuthSession.mockResolvedValue(null);
      expect((await proxy(request("/api/auth/oidc/test", { host: "localhost:20128" }))).status).toBe(401);
      // The SP metadata the IdP fetches stays public.
      expect(await proxy(request("/api/auth/saml/metadata", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    });

    it("doesn't let a password session from before the reset into the dashboard", async () => {
      mocks.verifyDashboardAuthToken.mockResolvedValue(true);
      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
      const response = await proxy(request("/dashboard", { host: "localhost:20128" }, "password-session"));
      expect(response.url.pathname).toBe("/login");
    });

    it("doesn't let a password session from before the reset use the API", async () => {
      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
      for (const path of ["/api/settings", "/api/keys", "/api/providers"]) {
        expect((await proxy(request(path, { host: "localhost:20128" }, "password-session"))).status, path).toBe(401);
      }
      // ALWAYS_PROTECTED routes too.
      expect((await proxy(request("/api/settings/database", { host: "localhost:20128" }, "password-session"))).status).toBe(401);
    });

    it("lets an SSO session and the CLI token use the API", async () => {
      mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true, oidc: true });
      expect(await proxy(request("/api/settings", { host: "localhost:20128" }, "sso-session"))).toBe(mocks.nextResponse);

      mocks.getDashboardAuthSession.mockResolvedValue(null);
      expect(await proxy(request("/api/settings", { host: "localhost:20128", "x-9r-cli-token": "cli-token" }))).toBe(mocks.nextResponse);
    });

    it("doesn't let requireLogin=false open the dashboard to anonymous visitors", async () => {
      mocks.getSettings.mockResolvedValue({ ...ssoDuringSetup, requireLogin: false });
      for (const path of ["/dashboard", "/dashboard/providers"]) {
        const response = await proxy(request(path, { host: "localhost:20128" }));
        expect(response.status, path).toBe(307);
        expect(response.url.pathname, path).toBe("/login");
      }
      const root = await proxy(request("/", { host: "localhost:20128" }));
      expect(root.url.pathname).toBe("/dashboard");
      expect((await proxy(request("/api/settings", { host: "localhost:20128" }))).status).toBe(401);
    });

    it("still funnels to /setup when the selected SSO isn't configured", async () => {
      mocks.getSettings.mockResolvedValue({ requireLogin: true, authMode: "both", ssoType: "saml" });
      const response = await proxy(request("/login", { host: "localhost:20128" }));
      expect(response.url.pathname).toBe("/setup");
    });
  });
});

describe("dashboard guard forced password change", () => {
  const RESTRICTED = { authenticated: true, pwChange: true };

  beforeEach(() => {
    vi.clearAllMocks();
    // Legacy install: password hash absent, grace stamp present.
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.getMeta.mockResolvedValue("1");
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    mocks.getDashboardAuthSession.mockResolvedValue(RESTRICTED);
  });

  it("sends a restricted session back to /login instead of the dashboard", async () => {
    const response = await proxy(request("/dashboard", { host: "localhost:20128" }, "restricted-jwt"));

    expect(response.status).toBe(307);
    expect(response.url.pathname).toBe("/login");
  });

  it("refuses protected APIs for a restricted session", async () => {
    const response = await proxy(request("/api/settings", { host: "localhost:20128" }, "restricted-jwt"));

    expect(response.status).toBe(403);
    expect(response.body.mustChangePassword).toBe(true);
  });

  it("refuses always-protected routes for a restricted session", async () => {
    const response = await proxy(request("/api/shutdown", { host: "localhost:20128" }, "restricted-jwt"));

    expect(response.status).toBe(403);
  });

  it("allows the change-password endpoint", async () => {
    const response = await proxy(request("/api/auth/change-password", { host: "localhost:20128" }, "restricted-jwt"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows logout so a restricted session is not a trap", async () => {
    const response = await proxy(request("/api/auth/logout", { host: "localhost:20128" }, "restricted-jwt"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("lets a full session through once the change is done", async () => {
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password: "$2a$10$storedhash" });
    mocks.getMeta.mockResolvedValue("0");

    const response = await proxy(request("/dashboard", { host: "localhost:20128" }, "full-jwt"));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });
});

describe("dashboard guard network trust", () => {
  const OPEN = { requireLogin: false, password: "$2a$10$storedhash" };
  const TUNNEL = { ...OPEN, tunnelUrl: "https://abc.trycloudflare.com", tailscaleUrl: "https://box.tail0.ts.net" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });

  it("refuses admin APIs on the tunnel host while tunnel dashboard access is off", async () => {
    mocks.getSettings.mockResolvedValue(TUNNEL);
    for (const host of ["abc.trycloudflare.com", "box.tail0.ts.net:443"]) {
      const response = await proxy(request("/api/keys", { host }));
      expect(response.status, host).toBe(403);
    }
  });

  // They sit under the public /api/version, which a prefix match let through.
  it("refuses /api/version/shutdown and /update on the tunnel host, even with a session", async () => {
    mocks.getSettings.mockResolvedValue(TUNNEL);
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    for (const path of ["/api/version/shutdown", "/api/version/update"]) {
      expect((await proxy(request(path, { host: "abc.trycloudflare.com" }, "session"))).status, path).toBe(403);
    }
    expect(await proxy(request("/api/version", { host: "abc.trycloudflare.com" }))).toBe(mocks.nextResponse);
  });

  it("serves admin APIs on the tunnel host once tunnel dashboard access is on", async () => {
    mocks.getSettings.mockResolvedValue({ ...TUNNEL, tunnelDashboardAccess: true });
    expect(await proxy(request("/api/keys", { host: "abc.trycloudflare.com" }))).toBe(mocks.nextResponse);
  });

  it("keeps public and LLM endpoints reachable on the tunnel host", async () => {
    mocks.getSettings.mockResolvedValue(TUNNEL);
    expect(await proxy(request("/api/health", { host: "abc.trycloudflare.com" }))).toBe(mocks.nextResponse);
    mocks.validateApiKey.mockResolvedValue(true);
    expect(await proxy(request("/v1/chat/completions", { host: "abc.trycloudflare.com", authorization: "Bearer sk-x" }))).toBe(mocks.nextResponse);
  });

  it("refuses a cross-site GET to a local-only spawn route even with no Origin", async () => {
    mocks.getSettings.mockResolvedValue(OPEN);
    const response = await proxy(localRequest("/api/mcp/browsermcp/sse", { host: "localhost:20128", "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
  });

  it("refuses cross-site and same-site writes when login is off", async () => {
    mocks.getSettings.mockResolvedValue(OPEN);
    for (const site of ["cross-site", "same-site"]) {
      const response = await proxy(request("/api/cli-tools/claude-settings", { host: "localhost:20128", "sec-fetch-site": site }));
      expect(response.status, site).toBe(401);
    }
  });

  it("keeps a page on another localhost port local for keyless /v1", async () => {
    mocks.getSettings.mockResolvedValue(OPEN);
    const response = await proxy(localRequest("/v1/chat/completions", { host: "localhost:20128", origin: "http://localhost:3000", "sec-fetch-site": "same-site" }));
    expect(response).toBe(mocks.nextResponse);
  });

  it("still serves the dashboard's own requests and non-browser clients when login is off", async () => {
    mocks.getSettings.mockResolvedValue(OPEN);
    expect(await proxy(request("/api/cli-tools/claude-settings", { host: "localhost:20128", "sec-fetch-site": "same-origin" }))).toBe(mocks.nextResponse);
    expect(await proxy(request("/api/cli-tools/claude-settings", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    expect(await proxy(localRequest("/api/mcp/browsermcp/sse", { host: "localhost:20128", "sec-fetch-site": "same-origin" }))).toBe(mocks.nextResponse);
  });

  it("decides keyless /v1 from this machine by Sec-Fetch-Site when there is no Origin", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true, password: "$2a$10$storedhash" });
    const crossSite = await proxy(localRequest("/v1/models", { host: "localhost:20128", "sec-fetch-site": "cross-site" }));
    expect(crossSite.status).toBe(401);
    // A typed URL or bookmark (none) and a non-browser client (no header) stay local.
    expect(await proxy(localRequest("/v1/models", { host: "localhost:20128", "sec-fetch-site": "none" }))).toBe(mocks.nextResponse);
    expect(await proxy(localRequest("/v1/models", { host: "localhost:20128" }))).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });
});

describe("dashboard guard Origin must match Host for cookie and login-off access", () => {
  const OPEN = { requireLogin: false, password: "$2a$10$storedhash" };
  const CLAIMED = { requireLogin: true, password: "$2a$10$storedhash" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });

  // Plain HTTP on a LAN address: browsers send no Sec-Fetch-* there, only Origin.
  it("refuses another page's request over plain HTTP when login is off", async () => {
    mocks.getSettings.mockResolvedValue(OPEN);
    for (const origin of ["http://attacker.example", "http://192.168.1.20:20128", "null"]) {
      const response = await proxy(request("/api/cli-tools/claude-settings", { host: "192.168.1.10:20128", origin }));
      expect(response.status, origin).toBe(401);
    }
  });

  it("refuses another page's request that carries the session cookie", async () => {
    mocks.getSettings.mockResolvedValue(CLAIMED);
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    const api = await proxy(request("/api/settings", { host: "192.168.1.10:20128", origin: "http://attacker.example" }, "session"));
    expect(api.status).toBe(401);
    const always = await proxy(request("/api/settings/database", { host: "192.168.1.10:20128", origin: "http://attacker.example" }, "session"));
    expect(always.status).toBe(401);
  });

  it("serves the dashboard's own requests, with or without a default port, and behind a Host-rewriting proxy", async () => {
    mocks.getSettings.mockResolvedValue(OPEN);
    expect(await proxy(request("/api/settings", { host: "192.168.1.10:20128", origin: "http://192.168.1.10:20128" }))).toBe(mocks.nextResponse);
    expect(await proxy(request("/api/settings", { host: "127.0.0.1:20128", "x-forwarded-host": "router.example.com", origin: "https://router.example.com" }))).toBe(mocks.nextResponse);
    mocks.getSettings.mockResolvedValue(CLAIMED);
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    expect(await proxy(request("/api/settings", { host: "router.example.com", origin: "https://router.example.com" }, "session"))).toBe(mocks.nextResponse);
    expect(await proxy(request("/api/settings", { host: "router.example.com:443", origin: "https://router.example.com" }, "session"))).toBe(mocks.nextResponse);
  });

  // nginx `proxy_set_header Host $host` drops the port of a proxy on 8443.
  it("serves the dashboard behind a proxy on a non-default port whose Host has no port", async () => {
    mocks.getSettings.mockResolvedValue(CLAIMED);
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    expect(await proxy(request("/api/settings", { host: "router.example.com", origin: "https://router.example.com:8443" }, "session"))).toBe(mocks.nextResponse);
    const otherPort = await proxy(request("/api/settings", { host: "router.example.com:8443", origin: "https://router.example.com:9443" }, "session"));
    expect(otherPort.status).toBe(401);
  });

  // A page with Referrer-Policy: no-referrer sends `Origin: null` even to itself.
  it("takes Sec-Fetch-Site: same-origin as proof, Origin: null from a no-referrer page included", async () => {
    mocks.getSettings.mockResolvedValue(CLAIMED);
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    expect(await proxy(request("/api/settings", { host: "router.example.com", origin: "null", "sec-fetch-site": "same-origin" }, "session"))).toBe(mocks.nextResponse);
    expect((await proxy(request("/api/settings", { host: "router.example.com", origin: "null" }, "session"))).status).toBe(401);
    expect((await proxy(request("/api/settings", { host: "router.example.com", origin: "null", "sec-fetch-site": "cross-site" }, "session"))).status).toBe(401);
  });

  it("still admits clients that send no Origin, and the CLI token from anywhere", async () => {
    mocks.getSettings.mockResolvedValue(OPEN);
    expect(await proxy(request("/api/settings", { host: "192.168.1.10:20128" }))).toBe(mocks.nextResponse);
    mocks.getSettings.mockResolvedValue(CLAIMED);
    expect(await proxy(request("/api/settings", { host: "192.168.1.10:20128", origin: "http://attacker.example", "x-9r-cli-token": "cli-token" }))).toBe(mocks.nextResponse);
  });

  it("compares host and port, letting a Host without a port match any", () => {
    const check = (headers) => __test__.isOtherOriginBrowserRequest(request("/api/settings", headers));
    expect(check({ host: "localhost:20128", origin: "http://localhost:3000" })).toBe(true);
    expect(check({ host: "localhost:20128", origin: "http://localhost:20128" })).toBe(false);
    expect(check({ host: "LOCALHOST:20128", origin: "http://localhost:20128" })).toBe(false);
    expect(check({ host: "router.example.com", origin: "https://router.example.com:8443" })).toBe(false);
    expect(check({ host: "router.example.com:443", origin: "https://router.example.com" })).toBe(false);
    expect(check({ host: "router.example.com.", origin: "https://router.example.com" })).toBe(false);
    expect(check({ host: "evil.example", origin: "https://router.example.com" })).toBe(true);
    expect(check({ host: "localhost:20128" })).toBe(false);
    expect(check({ origin: "http://localhost:20128" })).toBe(true);
  });

  // Only the first X-Forwarded-Host entry is the browser's Host; later ones are hops.
  it("reads the first entry of a multi-entry X-Forwarded-Host", () => {
    const check = (xfh) => __test__.isOtherOriginBrowserRequest(request("/api/settings", { host: "127.0.0.1:20128", "x-forwarded-host": xfh, origin: "https://router.example.com" }));
    expect(check("router.example.com, internal.lan")).toBe(false);
    expect(check(" router.example.com ,internal.lan")).toBe(false);
    expect(check("evil.example, router.example.com")).toBe(true);
  });
});

// With login off, a page on a domain the attacker points at this machine (DNS
// rebinding) is same-origin with it, so only Hosts that can't be rebound get in.
describe("dashboard guard login-off Host allowlist", () => {
  const OPEN = { requireLogin: false, password: "$2a$10$storedhash", tunnelUrl: "https://abc.trycloudflare.com" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(OPEN);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["localhost:20128", "127.0.0.1:20128", "[::1]:20128", "0.0.0.0:20128", "192.168.1.10:20128", "[2001:db8::5]:20128", "10.0.0.7"])(
    "admits the %s Host",
    async (host) => {
      expect(await proxy(request("/api/settings", { host, origin: `http://${host}` }))).toBe(mocks.nextResponse);
    }
  );

  it("refuses a rebound name, even same-origin", async () => {
    for (const host of ["rebind.attacker.example", "rebind.attacker.example:20128", "localhost.attacker.example"]) {
      const response = await proxy(request("/api/settings", { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" }));
      expect(response.status, host).toBe(401);
    }
  });

  it("admits the configured tunnel and base URL hosts", async () => {
    mocks.getSettings.mockResolvedValue({ ...OPEN, tunnelDashboardAccess: true });
    expect(await proxy(request("/api/settings", { host: "abc.trycloudflare.com" }))).toBe(mocks.nextResponse);
    expect((await proxy(request("/api/settings", { host: "router.example.com" }))).status).toBe(401);
    vi.stubEnv("BASE_URL", "https://router.example.com");
    expect(await proxy(request("/api/settings", { host: "router.example.com" }))).toBe(mocks.nextResponse);
    vi.stubEnv("BASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://Router.Example.com:8443/");
    expect(await proxy(request("/api/settings", { host: "router.example.com:8443" }))).toBe(mocks.nextResponse);
  });

  it("admits every host ALLOWED_HOSTS lists, as names or URLs", async () => {
    vi.stubEnv("ALLOWED_HOSTS", " router.example.com , https://Box.Example.net:8443/, nas.lan:20128 ,, ");
    for (const host of ["router.example.com", "router.example.com.:443", "box.example.net:8443", "nas.lan:20128", "NAS.LAN"]) {
      expect(await proxy(request("/api/settings", { host })), host).toBe(mocks.nextResponse);
    }
    for (const host of ["other.example.com", "example.com", "lan"]) {
      expect((await proxy(request("/api/settings", { host }))).status, host).toBe(401);
    }
  });

  it("admits a request with no Host and refuses one it can't parse", async () => {
    expect(await proxy(request("/api/settings"))).toBe(mocks.nextResponse);
    for (const host of ["exa mple.com", "[::1", "router.example.com:notaport"]) {
      expect((await proxy(request("/api/settings", { host }))).status, host).toBe(401);
    }
  });

  // nginx's default proxy_set_header Host $proxy_host: every name the browser
  // used, a rebound one included, arrives as the upstream's loopback or IP Host.
  // What custom-server.js stamps for a loopback proxy peer that isn't local
  // (PROXY_HOP), a TRUST_PROXY-listed peer that sent a forwarding header
  // (LISTED_HOP), and a direct peer from another address with no forwarding
  // header, listed in TRUST_PROXY or not (DOCKER_PEER).
  const PROXY_HOP = { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "203.0.113.9", "x-9r-socket-ip": "127.0.0.1", "x-9r-via-proxy": "1", "x-9r-proxy-hop": "loopback" };
  const LISTED_HOP = { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "203.0.113.9", "x-9r-socket-ip": "172.17.0.1", "x-9r-via-proxy": "1", "x-9r-proxy-hop": "listed" };
  const DOCKER_PEER = { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "172.17.0.1", "x-9r-socket-ip": "172.17.0.1", "x-9r-via-proxy": "1" };

  it("refuses a loopback Host from a proxy hop, however it is written", async () => {
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    for (const hop of [PROXY_HOP, LISTED_HOP]) {
      for (const host of ["127.0.0.1:20128", "localhost:20128", "[::1]:20128", "0.0.0.0:20128", "127.0.0.2", "127.1:20128", "2130706433", "[::ffff:127.0.0.1]:20128", "[0:0:0:0:0:0:0:1]"]) {
        expect((await proxy(request("/api/settings", { host, ...hop }))).status, `${hop["x-9r-proxy-hop"]} ${host}`).toBe(401);
      }
    }
    // A proxy that passes the browser's Host through is judged by that Host.
    vi.stubEnv("ALLOWED_HOSTS", "router.example.com");
    expect(await proxy(request("/api/settings", { host: "router.example.com", ...PROXY_HOP }))).toBe(mocks.nextResponse);
    expect(await proxy(request("/api/settings", { host: "router.example.com", ...LISTED_HOP }))).toBe(mocks.nextResponse);
  });

  // A listed proxy on another host with `proxy_pass http://192.168.1.5:20128`
  // (or a container IP) and the default Host $proxy_host sends that IP for every
  // name, a rebound one included.
  it("refuses an IP-literal Host from a listed proxy hop unless this install was given it", async () => {
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    for (const host of ["192.168.1.5:20128", "172.17.0.2:20128", "[2001:db8::5]:20128"]) {
      expect((await proxy(request("/api/settings", { host, ...LISTED_HOP }))).status, host).toBe(401);
    }
    // The IPs browsers type to reach the proxy, which passes Host through. An
    // IPv6 entry may be bare or bracketed.
    vi.stubEnv("ALLOWED_HOSTS", "router.example.com,192.168.1.5,2001:db8::5,[2001:db8::6]:8443");
    for (const host of ["192.168.1.5:20128", "[2001:db8::5]:20128", "[2001:db8::6]"]) {
      expect(await proxy(request("/api/settings", { host, ...LISTED_HOP })), host).toBe(mocks.nextResponse);
    }
    expect((await proxy(request("/api/settings", { host: "172.17.0.2:20128", ...LISTED_HOP }))).status).toBe(401);
    vi.stubEnv("BASE_URL", "http://198.51.100.20:8080");
    expect(await proxy(request("/api/settings", { host: "198.51.100.20:8080", ...LISTED_HOP }))).toBe(mocks.nextResponse);
  });

  // A same-host proxy's upstream is loopback, so an IP-literal Host behind it is
  // the browser's own: Caddy `reverse_proxy localhost:20128` opened as
  // http://192.168.1.5:8080, `tailscale serve` opened by its 100.x address.
  // A direct peer's IP-literal Host is the one the browser typed.
  it("keeps an IP-literal Host from a loopback proxy hop and from a direct peer", async () => {
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    for (const host of ["192.168.1.5:8080", "100.64.0.7", "[2001:db8::5]:20128"]) {
      expect(await proxy(request("/api/settings", { host, ...PROXY_HOP })), host).toBe(mocks.nextResponse);
      expect(await proxy(request("/api/settings", { host, ...DOCKER_PEER })), host).toBe(mocks.nextResponse);
      expect(await proxy(request("/api/settings", { host })), host).toBe(mocks.nextResponse);
    }
  });

  // Docker with a published port, ssh -L through a jump host, a WSL2 or VM NAT
  // forward: the peer isn't this machine, but nothing rewrote the browser's Host.
  it("keeps a loopback Host from a direct peer elsewhere, and from a client on this machine", async () => {
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    for (const host of ["localhost:20128", "127.0.0.1:20128", "[::1]:20128"]) {
      expect(await proxy(request("/api/settings", { host, ...DOCKER_PEER })), host).toBe(mocks.nextResponse);
      expect(await proxy(localRequest("/api/settings", { host })), host).toBe(mocks.nextResponse);
    }
    // A client's own proxy-hop stamp, without the wrapper's proof, is ignored.
    expect(await proxy(request("/api/settings", { host: "127.0.0.1:20128", "x-9r-proxy-hop": "1" }))).toBe(mocks.nextResponse);
  });

  it("leaves a session and the CLI token alone on any Host", async () => {
    mocks.getSettings.mockResolvedValue({ ...OPEN, requireLogin: true });
    mocks.getDashboardAuthSession.mockResolvedValue({ authenticated: true });
    expect(await proxy(request("/api/settings", { host: "router.example.com" }, "session"))).toBe(mocks.nextResponse);
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    expect(await proxy(request("/api/settings", { host: "router.example.com", "x-9r-cli-token": "cli-token" }))).toBe(mocks.nextResponse);
  });
});

// A spawn route reached by GET (<img>, EventSource) from another page carries no
// Origin, and over http://0.0.0.0 (not a secure context) no Sec-Fetch-Site either.
describe("dashboard guard local-only GET routes need same-origin proof", () => {
  const OPEN = { requireLogin: false, password: "$2a$10$storedhash" };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue(OPEN);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });

  it("refuses a proof-less GET to an MCP spawn route, 0.0.0.0 included", async () => {
    for (const host of ["0.0.0.0:20128", "localhost:20128", "127.0.0.1:20128"]) {
      const response = await proxy(localRequest("/api/mcp/browsermcp/sse", { host }));
      expect(response.status, host).toBe(403);
    }
  });

  it("serves the dashboard's own GET, a typed URL, a matching Origin and the CLI token", async () => {
    for (const headers of [
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { origin: "http://0.0.0.0:20128" },
      { "x-9r-cli-token": "cli-token" },
    ]) {
      expect(await proxy(localRequest("/api/mcp/browsermcp/sse", { host: "0.0.0.0:20128", ...headers })), JSON.stringify(headers)).toBe(mocks.nextResponse);
    }
  });

  it("treats HEAD like GET", async () => {
    const head = { ...localRequest("/api/mcp/browsermcp/sse", { host: "0.0.0.0:20128" }), method: "HEAD" };
    expect((await proxy(head)).status).toBe(403);
    const proven = { ...localRequest("/api/mcp/browsermcp/sse", { host: "0.0.0.0:20128", "sec-fetch-site": "same-origin" }), method: "head" };
    expect(await proxy(proven)).toBe(mocks.nextResponse);
  });

  it("leaves non-GET local-only requests to the Origin checks", async () => {
    const post = { ...localRequest("/api/tunnel/enable", { host: "localhost:20128" }), method: "POST" };
    expect(await proxy(post)).toBe(mocks.nextResponse);
  });

  it("knows proof when it sees it", () => {
    const proof = (headers) => __test__.hasSameOriginProof(request("/api/mcp/x/sse", headers));
    expect(proof({ host: "localhost:20128" })).toBe(false);
    expect(proof({ host: "localhost:20128", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(proof({ host: "localhost:20128", origin: "http://evil.example" })).toBe(false);
    expect(proof({ host: "localhost:20128", origin: "http://localhost:20128" })).toBe(true);
    expect(proof({ host: "localhost:20128", "sec-fetch-site": "same-origin" })).toBe(true);
  });
});

// custom-server.js can't import from src/, so it has its own copy of the
// loopback rule. The two must agree on every form either one sees.
describe("loopback host rule parity with custom-server.js", () => {
  const require = createRequire(import.meta.url);
  const SERVER_PATH = require.resolve("../../custom-server.js");
  const originalCreateServer = http.createServer;
  let isLoopbackHost;
  let peerToken;

  beforeAll(() => {
    peerToken = process.env.NINEROUTER_PEER_TOKEN;
    ({ isLoopbackHost } = require(SERVER_PATH).__test__);
  });
  afterAll(() => {
    http.createServer = originalCreateServer;
    delete require.cache[SERVER_PATH];
    if (peerToken === undefined) delete process.env.NINEROUTER_PEER_TOKEN;
    else process.env.NINEROUTER_PEER_TOKEN = peerToken;
  });

  it.each([
    "localhost", "LOCALHOST", "localhost:20128", "127.0.0.1", "127.0.0.1:20128", "0.0.0.0", "0.0.0.0:20128",
    "::1", "[::1]", "[::1]:20128", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]:20128", " 127.0.0.1 ",
    "[::1", "127.0.0.2", "10.0.0.1", "192.168.1.10:20128", "2001:db8::1", "router.example.com",
    "localhost.example.com", "unknown", "",
  ])("%j", (value) => {
    expect(__test__.isLoopbackHostname(value)).toBe(isLoopbackHost(value));
  });

  it("treats 0.0.0.0 as loopback in both", () => {
    expect(__test__.isLoopbackHostname("0.0.0.0:20128")).toBe(true);
    expect(isLoopbackHost("0.0.0.0:20128")).toBe(true);
  });
});

describe("dashboard guard tunnel host", () => {
  const TUNNEL = { requireLogin: false, password: "$2a$10$storedhash", tunnelUrl: "https://abc.trycloudflare.com", tailscaleUrl: "https://box.tail0.ts.net" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(TUNNEL);
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.getDashboardAuthSession.mockResolvedValue(null);
    mocks.getMeta.mockResolvedValue("0");
  });

  it.each([
    ["exact", "abc.trycloudflare.com", true],
    ["mixed case", "ABC.TryCloudflare.com", true],
    ["trailing dot", "abc.trycloudflare.com.", true],
    ["trailing dot and port", "abc.trycloudflare.com.:443", true],
    ["port", "box.tail0.ts.net:443", true],
    ["another host", "router.example.com", false],
    ["a subdomain of it", "x.abc.trycloudflare.com", false],
    ["no Host", "", false],
  ])("matches the %s Host", (_name, host, expected) => {
    expect(isTunnelHost(request("/api/keys", host ? { host } : {}), TUNNEL)).toBe(expected);
  });

  it("matches a stored URL with a trailing dot or upper case", () => {
    expect(isTunnelHost(request("/", { host: "abc.trycloudflare.com" }), { tunnelUrl: "https://ABC.trycloudflare.com./" })).toBe(true);
  });

  it("matches nothing, rather than throwing, for a malformed stored URL", async () => {
    const broken = { ...TUNNEL, tunnelUrl: "not a url", tailscaleUrl: "::" };
    expect(isTunnelHost(request("/", { host: "abc.trycloudflare.com" }), broken)).toBe(false);
    mocks.getSettings.mockResolvedValue(broken);
    // No 500: the page loads, and the open API refuses a Host it can't place.
    expect(await proxy(request("/dashboard", { host: "abc.trycloudflare.com" }))).toBe(mocks.nextResponse);
    expect((await proxy(request("/api/keys", { host: "abc.trycloudflare.com" }))).status).toBe(401);
  });

  // A stale stored URL (the quick tunnel got a new name) must not let tunnel traffic in.
  it("treats traffic custom-server.js stamped as tunnel traffic as tunnel traffic, whatever its Host", async () => {
    const stale = { ...TUNNEL, tunnelUrl: "https://old.trycloudflare.com" };
    mocks.getSettings.mockResolvedValue(stale);
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    const stamped = { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "203.0.113.9", "x-9r-via-proxy": "1", "x-9r-via-tunnel": "1" };
    expect(isTunnelHost(request("/", { host: "new.trycloudflare.com", ...stamped }), stale)).toBe(true);
    expect((await proxy(request("/api/keys", { host: "new.trycloudflare.com", ...stamped }))).status).toBe(403);
    expect((await proxy(request("/dashboard", { host: "new.trycloudflare.com", ...stamped }))).url.pathname).toBe("/login");
    // A client's own stamp, without the wrapper's proof, means nothing.
    expect(isTunnelHost(request("/", { host: "new.trycloudflare.com", "x-9r-via-tunnel": "1" }), stale)).toBe(false);
  });

  it("redirects the dashboard pages on the tunnel host to /login while access is off", async () => {
    for (const host of ["abc.trycloudflare.com", "ABC.trycloudflare.com.:443"]) {
      const response = await proxy(request("/dashboard", { host }));
      expect(response.status, host).toBe(307);
      expect(response.url.pathname, host).toBe("/login");
    }
    mocks.getSettings.mockResolvedValue({ ...TUNNEL, tunnelDashboardAccess: true });
    expect(await proxy(request("/dashboard", { host: "abc.trycloudflare.com" }))).toBe(mocks.nextResponse);
  });
});
