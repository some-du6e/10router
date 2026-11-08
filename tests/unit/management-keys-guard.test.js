// The dashboard guard's side of management keys: /api/management/v1 takes a
// management key and nothing else, and a management key opens nothing else,
// neither the dashboard APIs nor /v1 inference. Real management keys on a
// throwaway database; the session check and NextResponse are stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mgmt-guard-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const NEXT = Symbol("next");
const state = { settings: { requireLogin: true, password: "$2a$10$storedhash" } };

vi.mock("next/server", () => ({
  NextResponse: {
    next: () => NEXT,
    json: (body, init) => ({ status: init?.status || 200, body }),
    redirect: (url) => ({ status: 307, url: String(url) }),
  },
}));
vi.mock("@/lib/localDb", async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: async () => state.settings,
}));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "cli-token" }));
// A cookie of "good-session" is a valid dashboard login.
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: async (t) => t === "good-session",
  getDashboardAuthSession: async (t) => (t === "good-session" ? { sub: "admin" } : null),
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");
const db = await import("@/lib/db/index.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, { headers = {}, cookie, local = false } = {}) {
  const h = new Headers(headers);
  if (local) {
    h.set("x-9r-peer-token", PEER_TOKEN);
    h.set("x-9r-real-ip", "127.0.0.1");
  }
  const url = `http://localhost${pathname}`;
  return {
    nextUrl: { pathname: new URL(url).pathname, searchParams: new URL(url).searchParams },
    headers: h,
    cookies: { get: () => (cookie ? { value: cookie } : undefined) },
    url,
  };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

let mgmt;
let clientKey;

beforeAll(async () => {
  process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
  const full = { clientKeys: { enabled: true, manageExisting: true }, providerKeys: { enabled: true, manageExisting: true } };
  mgmt = (await db.createManagementKey({ name: "admin-ish", scopes: full })).secret;
  clientKey = (await db.createApiKey("client", "machine-test-0001")).key;
});

beforeEach(() => {
  state.settings = { requireLogin: true, password: "$2a$10$storedhash" };
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

/** Every API route in the app, as a request path ([id] → "x", [...rest] → "x/y"). */
function allApiPaths() {
  const root = fileURLToPath(new URL("../../src/app/api", import.meta.url));
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^route\.(js|ts)$/.test(entry.name)) {
        const rel = path.relative(root, dir).split(path.sep)
          .map((seg) => (seg.startsWith("[...") || seg.startsWith("[[...") ? "x/y" : seg.startsWith("[") ? "x" : seg));
        out.push(`/api/${rel.join("/")}`.replace(/\/$/, ""));
      }
    }
  };
  walk(root);
  return out;
}

describe("a management key opens no other dashboard API", () => {
  const paths = allApiPaths();
  const others = paths.filter((p) => !p.startsWith("/api/management/v1") && !__test__.isPublicApi(p));

  it("finds the routes to check", () => {
    expect(others.length).toBeGreaterThan(100);
    expect(others).toEqual(expect.arrayContaining(["/api/keys", "/api/providers", "/api/management-keys", "/api/management-keys/x", "/api/settings"]));
  });

  it("gets 401 or 403 on every protected API route, remote or from loopback, in every header form", async () => {
    const forms = [bearer(mgmt), { "x-api-key": mgmt }, { "x-goog-api-key": mgmt }];
    for (const p of others) {
      for (const headers of forms) {
        for (const local of [false, true]) {
          const res = await proxy(request(p, { headers, local }));
          expect(res, `${p} ${Object.keys(headers)[0]} local=${local}`).not.toBe(NEXT);
          expect([401, 403], p).toContain(res.status);
        }
      }
    }
  });

  it("does not open the dashboard pages either", async () => {
    const res = await proxy(request("/dashboard/endpoint", { headers: bearer(mgmt) }));
    expect(res).not.toBe(NEXT);
    expect(res.status).toBe(307);
  });

  it("does not open look-alike paths outside /api/management/v1", async () => {
    for (const p of ["/api/management", "/api/management/v1x", "/api/management/v2/client-keys", "/api/managementv1/me", "/api/management-keys"]) {
      const res = await proxy(request(p, { headers: bearer(mgmt) }));
      expect(res, p).not.toBe(NEXT);
      expect(res.status, p).toBe(401);
    }
  });

  it("while a session still opens the dashboard's management-keys API", async () => {
    expect(await proxy(request("/api/management-keys", { cookie: "good-session" }))).toBe(NEXT);
  });
});

describe("the management API takes a management key and nothing else", () => {
  const routes = ["/api/management/v1/me", "/api/management/v1/client-keys", "/api/management/v1/client-keys/x", "/api/management/v1/provider-keys/x"];

  it("lets a valid management key through without a session", async () => {
    for (const p of routes) {
      expect(await proxy(request(p, { headers: bearer(mgmt) })), p).toBe(NEXT);
    }
  });

  it("refuses a session, a CLI token, requireLogin=false and loopback without a key", async () => {
    for (const p of routes) {
      expect((await proxy(request(p, { cookie: "good-session" }))).status, p).toBe(401);
      expect((await proxy(request(p, { headers: { "x-9r-cli-token": "cli-token" } }))).status, p).toBe(401);
      expect((await proxy(request(p, { local: true }))).status, p).toBe(401);
    }
    state.settings = { requireLogin: false, password: "$2a$10$storedhash" };
    for (const p of routes) expect((await proxy(request(p))).status, p).toBe(401);
  });

  it("refuses a client key, a made-up key, and a management key sent other than as a bearer token", async () => {
    for (const headers of [bearer(clientKey), bearer("10r-mgmt-made-up"), { "x-api-key": mgmt }]) {
      const res = await proxy(request("/api/management/v1/me", { headers }));
      expect(res.status).toBe(401);
    }
  });

  it("refuses a key that is turned off, expired or revoked", async () => {
    const scopes = { providerKeys: { enabled: true } };
    const off = await db.createManagementKey({ name: "off", scopes });
    await db.updateManagementKey(off.managementKey.id, { isActive: false });
    const expired = await db.createManagementKey({ name: "expired", scopes, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const revoked = await db.createManagementKey({ name: "revoked", scopes });
    expect(await proxy(request("/api/management/v1/me", { headers: bearer(revoked.secret) }))).toBe(NEXT);
    await db.deleteManagementKey(revoked.managementKey.id);
    for (const { secret } of [off, expired, revoked]) {
      expect((await proxy(request("/api/management/v1/me", { headers: bearer(secret) }))).status).toBe(401);
    }
  });
});

describe("a management key never authenticates on /v1", () => {
  const inference = ["/v1/chat/completions", "/api/v1/chat/completions", "/v1/messages", "/v1/models", "/v1beta/models", "/codex/responses", "/responses"];

  it("is refused with 401, remote and from loopback, in every place a client key is read from", async () => {
    for (const p of inference) {
      for (const local of [false, true]) {
        for (const r of [
          request(p, { headers: bearer(mgmt), local }),
          request(p, { headers: { "x-api-key": mgmt }, local }),
          request(p, { headers: { "x-goog-api-key": mgmt }, local }),
          request(`${p}?key=${mgmt}`, { local }),
        ]) {
          const res = await proxy(r);
          expect(res, `${p} local=${local}`).not.toBe(NEXT);
          expect(res.status).toBe(401);
        }
      }
    }
  });

  it("while a client key still gets through remotely", async () => {
    expect(await proxy(request("/v1/chat/completions", { headers: bearer(clientKey) }))).toBe(NEXT);
  });
});
