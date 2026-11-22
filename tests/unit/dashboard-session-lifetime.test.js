import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, decodeJwt } from "jose";
import bcrypt from "bcryptjs";
import { parseSetCookie } from "next/dist/compiled/@edge-runtime/cookies/index.js";

const THIRTY_DAYS = 2592000;
const ONE_DAY = 86400;
const TEN_MINUTES = 600;
const SECRET = "lifetime-test-secret-".padEnd(48, "x");

const state = vi.hoisted(() => ({
  settings: {},
  meta: new Map(),
  bootstrap: "claimed",
  requestCookies: {},
  responseHeaders: null,
  jar: null,
  importDb: null,
}));

vi.mock("@/lib/auth/authSecret.js", () => ({ getAuthSecret: () => SECRET }));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ ...state.settings })),
  updateSettings: vi.fn(async (updates) => {
    state.settings = { ...state.settings, ...updates };
    return state.settings;
  }),
  exportDb: vi.fn(async () => ({})),
  importDb: vi.fn(async (payload) => state.importDb?.(payload)),
}));

vi.mock("@/lib/db/helpers/metaStore.js", () => ({
  getMeta: vi.fn(async (key, fallback = null) => (state.meta.has(key) ? state.meta.get(key) : fallback)),
  setMeta: vi.fn(async (key, value) => {
    state.meta.set(key, String(value));
  }),
}));

vi.mock("@/lib/auth/setupState", () => ({
  getBootstrapSecret: vi.fn(async () => (state.bootstrap === "legacy" ? "123456" : null)),
  getEnvInitialPassword: vi.fn(() => null),
  needsSetup: vi.fn(async () => false),
  getAuthBootstrapState: vi.fn(async () => state.bootstrap),
  validateNewPassword: vi.fn(() => ({ ok: true })),
  clearLegacyGrace: vi.fn(async () => {}),
  MIN_PASSWORD_LENGTH: 8,
}));

vi.mock("@/lib/auth/setupToken", () => ({
  consumeSetupToken: () => ({ ok: true }),
  getSetupTokenState: () => ({ present: true, expired: false, expiresInSec: 60 }),
  clearSetupToken: vi.fn(),
  SETUP_WINDOW_MS: 1000,
}));
vi.mock("@/lib/auth/setupBootstrap", () => ({ ensureSetupToken: vi.fn() }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: () => ({ locked: false }),
  recordFail: () => ({ remainingBeforeLock: 4 }),
  recordSuccess: vi.fn(),
  reserveAttempt: () => ({ ok: true }),
  releaseAttempt: vi.fn(),
  getClientKeys: () => ["127.0.0.1"],
  LOCAL_LOGIN_KEY: "local",
}));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: () => true, isTunnelHost: () => false }));
vi.mock("@/lib/auth/cliToken.js", () => ({ CLI_TOKEN_HEADER: "x-cli-token", isValidCliToken: async () => false }));
vi.mock("@/lib/auth/oidc", () => ({
  getOidcRuntimeConfig: async () => ({ issuerUrl: "https://idp.example.test", clientId: "client", scopes: "openid" }),
  fetchOidcDiscovery: async () => ({
    issuer: "https://idp.example.test",
    authorization_endpoint: "https://idp.example.test/authorize",
    token_endpoint: "t",
    jwks_uri: "j",
  }),
  buildOidcAuthorizationUrl: () => "https://idp.example.test/authorize?x=1",
  createOidcState: () => "st",
  createOidcNonce: () => "n",
  createPkcePair: () => ({ verifier: "v", challenge: "c" }),
  exchangeOidcCode: async () => ({ id_token: "id" }),
  getPublicOrigin: () => "https://dash.example.test",
  pickOidcEmail: (payload) => payload.email || "",
  pickOidcDisplayName: () => "User",
  verifyOidcIdToken: async () => ({ sub: "sub-1", email: "owner@example.test", email_verified: true }),
}));
vi.mock("@/lib/auth/saml.js", () => ({
  getSamlBaseUrl: () => "https://dash.example.test",
  pickSamlEmail: (profile) => profile.email,
  pickSamlDisplayName: () => "User",
  validateSamlResponse: async () => ({ nameID: "owner", email: "owner@example.test" }),
}));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
vi.mock("@/sse/services/autoCombo.js", () => ({ sanitizeAutoComboSetting: (value) => value }));
vi.mock("@/lib/db/index.js", () => ({ clearRequestDetailFullData: vi.fn() }));

// Cookies a route sets go through Next's own ResponseCookies, so the test reads
// the Set-Cookie headers a browser would get.
vi.mock("next/headers", async () => {
  const { ResponseCookies } = await import("next/dist/compiled/@edge-runtime/cookies/index.js");
  return {
    cookies: async () => {
      state.jar ??= new ResponseCookies(state.responseHeaders);
      return {
        get: (name) => (name in state.requestCookies ? { value: state.requestCookies[name] } : undefined),
        set: (...args) => state.jar.set(...args),
        delete: (name) => state.jar.delete(name),
      };
    },
  };
});

const session = await import("../../src/lib/auth/dashboardSession.js");
const routes = {
  login: await import("../../src/app/api/auth/login/route.js"),
  setup: await import("../../src/app/api/auth/setup/route.js"),
  changePassword: await import("../../src/app/api/auth/change-password/route.js"),
  oidcStart: await import("../../src/app/api/auth/oidc/start/route.js"),
  oidcCallback: await import("../../src/app/api/auth/oidc/callback/route.js"),
  samlAcs: await import("../../src/app/api/auth/saml/acs/route.js"),
  settings: await import("../../src/app/api/settings/route.js"),
  database: await import("../../src/app/api/settings/database/route.js"),
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let PASSWORD_HASH;

const jsonRequest = (url, body, method = "POST") =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setCookies(name) {
  return state.responseHeaders.getSetCookie().filter((header) => header.startsWith(`${name}=`));
}

function lastAuthCookie() {
  const headers = setCookies("auth_token");
  expect(headers.length).toBeGreaterThan(0);
  return parseSetCookie(headers.at(-1));
}

function expectExpiresIn(cookie, seconds, before) {
  const expires = cookie.expires.getTime() / 1000;
  expect(expires, cookie.name).toBeGreaterThanOrEqual(before + seconds - 1);
  expect(expires, cookie.name).toBeLessThanOrEqual(Date.now() / 1000 + seconds + 1);
}

function forgeLegacyToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(new TextEncoder().encode(SECRET));
}

beforeAll(() => {
  PASSWORD_HASH = bcrypt.hashSync("current-password-1", 4);
});

beforeEach(() => {
  state.settings = { password: PASSWORD_HASH, requireLogin: true };
  state.meta = new Map();
  state.bootstrap = "claimed";
  state.requestCookies = {};
  state.responseHeaders = new Headers();
  state.jar = null;
  state.importDb = null;
});

// Every route that writes auth_token, driven to the branch that signs the caller in.
const SIGN_INS = {
  "password login": async () =>
    routes.login.POST(jsonRequest("http://localhost/api/auth/login", { password: "current-password-1" })),
  "first-run setup": async () => {
    state.bootstrap = "setup";
    state.settings = {};
    return routes.setup.POST(jsonRequest("http://localhost/api/auth/setup", { token: "tok", password: "a-new-password-1" }));
  },
  "forced password change": async () => {
    state.bootstrap = "legacy";
    state.requestCookies.auth_token = await session.createDashboardAuthToken({ pwChange: true });
    return routes.changePassword.POST(jsonRequest("http://localhost/api/auth/change-password", { newPassword: "a-new-password-1" }));
  },
  "OIDC callback": async () => {
    Object.assign(state.requestCookies, { oidc_state: "st", oidc_nonce: "n", oidc_code_verifier: "v" });
    return routes.oidcCallback.GET(new Request("https://dash.example.test/api/auth/oidc/callback?code=c&state=st"));
  },
  "SAML ACS": async () => {
    Object.assign(state.settings, { authMode: "sso", ssoType: "saml", samlEntryPoint: "https://idp.example.test/sso", samlCert: "cert" });
    const body = new FormData();
    body.set("SAMLResponse", "resp");
    return routes.samlAcs.POST(new Request("https://dash.example.test/api/auth/saml/acs", { method: "POST", body }));
  },
  "settings password change": async () => {
    state.requestCookies.auth_token = await session.createDashboardAuthToken();
    return routes.settings.PATCH(
      jsonRequest("http://localhost/api/settings", { currentPassword: "current-password-1", newPassword: "new-password-1" }, "PATCH"),
    );
  },
  "password-changing DB import": async () => {
    state.requestCookies.auth_token = await session.createDashboardAuthToken();
    state.importDb = () => session.revokeDashboardSessions();
    return routes.database.POST(jsonRequest("http://localhost/api/settings/database", { password: "current-password-1", settings: {} }));
  },
};

describe("dashboard sign-in lasts 30 days", () => {
  it.each(Object.entries(SIGN_INS))("%s sets a persistent auth_token cookie whose JWT lasts as long", async (_label, signIn) => {
    const before = Math.floor(Date.now() / 1000);
    const res = await signIn();
    expect(res.status).toBeLessThan(400);

    const cookie = lastAuthCookie();
    expect(cookie).toEqual(expect.objectContaining({ maxAge: THIRTY_DAYS, path: "/", httpOnly: true, sameSite: "lax" }));
    expectExpiresIn(cookie, THIRTY_DAYS, before);

    const payload = decodeJwt(cookie.value);
    expect(payload.exp - payload.iat).toBe(THIRTY_DAYS);
    expect(payload.pwChange).toBeUndefined();
    expect(await session.getDashboardAuthSession(cookie.value)).toBeTruthy();
  });

  // Only dashboardSession.js mints tokens or writes auth_token.
  it("covers every route that signs a browser in", () => {
    const writers = [];
    for (const rel of fs.readdirSync(path.join(REPO_ROOT, "src"), { recursive: true })) {
      if (!/\.[cm]?[jt]sx?$/.test(rel)) continue;
      const file = path.join("src", rel).split(path.sep).join("/");
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (/\b(setDashboardAuthCookie|reissueDashboardSession)\b/.test(source)) writers.push(file);
      if (file === "src/lib/auth/dashboardSession.js") continue;
      expect(source, file).not.toMatch(/\bcreateDashboardAuthToken\b/);
      expect(source, file).not.toMatch(/(\.set\(\s*|name:\s*)["'`]auth_token["'`]|\bauth_token=/);
    }
    expect(writers.sort()).toEqual([
      "src/app/api/auth/change-password/route.js",
      "src/app/api/auth/login/route.js",
      "src/app/api/auth/oidc/callback/route.js",
      "src/app/api/auth/saml/acs/route.js",
      "src/app/api/auth/setup/route.js",
      "src/app/api/settings/database/route.js",
      "src/app/api/settings/route.js",
      "src/lib/auth/dashboardSession.js",
    ]);
    expect(Object.keys(SIGN_INS)).toHaveLength(writers.length - 1);
  });

  it("keeps the forced-password-change session a short browser-session cookie", async () => {
    state.bootstrap = "legacy";
    state.settings = {};
    const res = await routes.login.POST(jsonRequest("http://localhost/api/auth/login", { password: "123456" }));
    expect(res.status).toBe(403);

    const cookie = lastAuthCookie();
    expect(cookie.maxAge).toBeUndefined();
    expect(cookie.expires).toBeUndefined();
    const payload = decodeJwt(cookie.value);
    expect(payload.pwChange).toBe(true);
    expect(payload.exp - payload.iat).toBe(ONE_DAY);
  });

  it("leaves the OIDC state, nonce and verifier cookies at 10 minutes", async () => {
    const before = Math.floor(Date.now() / 1000);
    await routes.oidcStart.GET(new Request("https://dash.example.test/api/auth/oidc/start"));
    for (const name of ["oidc_state", "oidc_nonce", "oidc_code_verifier"]) {
      const headers = setCookies(name);
      expect(headers, name).toHaveLength(1);
      const cookie = parseSetCookie(headers[0]);
      expect(cookie.maxAge, name).toBe(TEN_MINUTES);
      expectExpiresIn(cookie, TEN_MINUTES, before);
    }
    expect(setCookies("auth_token")).toHaveLength(0);
  });

  it("logout expires the persistent cookie on the path it was set on", async () => {
    await SIGN_INS["password login"]();
    const signedIn = lastAuthCookie();
    state.requestCookies.auth_token = signedIn.value;
    const { POST } = await import("../../src/app/api/auth/logout/route.js");
    await POST();

    const cleared = lastAuthCookie();
    expect(cleared.value ?? "").toBe("");
    expect(cleared.path).toBe(signedIn.path);
    expect(cleared.domain).toBe(signedIn.domain);
    expect(cleared.expires.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await session.verifyDashboardAuthToken(signedIn.value)).toBe(false);
  });
});

describe("sessions over time", () => {
  const START = Date.UTC(2026, 0, 1);
  const at = (seconds) => vi.setSystemTime(START + seconds * 1000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a sign-in still works after 29 days and ends at 30", async () => {
    const token = await session.createDashboardAuthToken();
    at(29 * ONE_DAY);
    expect(await session.verifyDashboardAuthToken(token)).toBe(true);
    at(THIRTY_DAYS + 1);
    expect(await session.verifyDashboardAuthToken(token)).toBe(false);
  });

  it("revocation ends a 30-day session long before it expires", async () => {
    const token = await session.createDashboardAuthToken({ oidc: true, oidcSub: "sub-1" });
    at(ONE_DAY * 2);
    expect(await session.verifyDashboardAuthToken(token)).toBe(true);
    await session.revokeDashboardSessions();
    expect(await session.verifyDashboardAuthToken(token)).toBe(false);
    expect(await session.verifyDashboardAuthToken(await session.createDashboardAuthToken())).toBe(true);
  });

  it("the forced-password-change session still ends after 24 hours", async () => {
    const token = await session.createDashboardAuthToken({ pwChange: true });
    at(ONE_DAY - 60);
    expect(await session.getDashboardAuthSession(token)).toBeTruthy();
    at(ONE_DAY + 1);
    expect(await session.getDashboardAuthSession(token)).toBeNull();
  });

  it("still accepts a 24-hour token issued before the change", async () => {
    const legacy = await forgeLegacyToken();
    at(ONE_DAY - 60);
    expect(await session.verifyDashboardAuthToken(legacy)).toBe(true);

    at(0);
    await session.revokeDashboardSessions();
    const underEpoch = await forgeLegacyToken({ sep: state.meta.values().next().value });
    at(ONE_DAY - 60);
    expect(await session.verifyDashboardAuthToken(underEpoch)).toBe(true);
    at(ONE_DAY + 1);
    expect(await session.verifyDashboardAuthToken(underEpoch)).toBe(false);
  });
});
