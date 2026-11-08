// Management keys: scoped keys for /api/management/v1 that list, create, edit
// and delete client keys and provider keys. Runs the real route handlers on a
// throwaway database. Only the provider validation ping is stubbed, so no
// upstream is called. The guard side (which paths take a management key) is
// in management-keys-guard.test.js.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mgmt-keys-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const MACHINE = "machine-test-0001";
// The validation ping: valid or not, or a custom handler (to hang, fail, or act mid-probe).
const validation = { valid: true, calls: [], handler: null };

vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => MACHINE }));
vi.mock("@/app/api/providers/validate/route.js", () => ({
  POST: async (request) => {
    const body = await request.json();
    validation.calls.push(body);
    if (validation.handler) return validation.handler(body);
    return Response.json({ valid: validation.valid, error: validation.valid ? null : `upstream said no to ${body.apiKey}` });
  },
}));
// A cookie of "good-session" is a valid dashboard login.
vi.mock("@/lib/auth/dashboardSession", () => ({
  getDashboardAuthSession: async (t) => (t === "good-session" ? { sub: "admin" } : null),
  verifyDashboardAuthToken: async (t) => t === "good-session",
}));

const db = await import("@/lib/db/index.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const handlers = await import("@/lib/management/handlers.js");
const { authenticateManagementKey } = await import("@/lib/management/auth.js");
const me = await import("@/app/api/management/v1/me/route.js");
const clientKeys = await import("@/app/api/management/v1/client-keys/route.js");
const clientKey = await import("@/app/api/management/v1/client-keys/[id]/route.js");
const providerKeys = await import("@/app/api/management/v1/provider-keys/route.js");
const providerKey = await import("@/app/api/management/v1/provider-keys/[id]/route.js");
const dashKeys = await import("@/app/api/management-keys/route.js");
const dashKey = await import("@/app/api/management-keys/[id]/route.js");
const keysRoute = await import("@/app/api/keys/[id]/route.js");
const { maskClientKey } = await import("@/lib/management/serialize.js");

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

// Every response body the tests see, for the no-secrets checks at the end.
const seen = [];

async function call(handler, request, params) {
  const res = await handler(request, params ? { params: Promise.resolve(params) } : undefined);
  const text = await res.text();
  const label = `${request.method} ${new URL(request.url).pathname}`;
  seen.push({ label, status: res.status, text });
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}

function req(pathname, { method = "GET", token, body, headers = {} } = {}) {
  const h = new Headers(headers);
  if (token) h.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) h.set("Content-Type", "application/json");
  return new Request(`http://localhost${pathname}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

const api = {
  me: (token) => call(me.GET, req("/api/management/v1/me", { token })),
  listClient: (token) => call(clientKeys.GET, req("/api/management/v1/client-keys", { token })),
  createClient: (token, body) => call(clientKeys.POST, req("/api/management/v1/client-keys", { method: "POST", token, body })),
  getClient: (token, id) => call(clientKey.GET, req(`/api/management/v1/client-keys/${id}`, { token }), { id }),
  patchClient: (token, id, body) => call(clientKey.PATCH, req(`/api/management/v1/client-keys/${id}`, { method: "PATCH", token, body }), { id }),
  deleteClient: (token, id) => call(clientKey.DELETE, req(`/api/management/v1/client-keys/${id}`, { method: "DELETE", token }), { id }),
  listProvider: (token, query = "") => call(providerKeys.GET, req(`/api/management/v1/provider-keys${query}`, { token })),
  createProvider: (token, body) => call(providerKeys.POST, req("/api/management/v1/provider-keys", { method: "POST", token, body })),
  getProvider: (token, id) => call(providerKey.GET, req(`/api/management/v1/provider-keys/${id}`, { token }), { id }),
  deleteProvider: (token, id) => call(providerKey.DELETE, req(`/api/management/v1/provider-keys/${id}`, { method: "DELETE", token }), { id }),
};

const SESSION = { cookie: "auth_token=good-session" };
const dashboard = {
  list: (headers = SESSION) => call(dashKeys.GET, req("/api/management-keys", { headers })),
  create: (body, headers = SESSION) => call(dashKeys.POST, req("/api/management-keys", { method: "POST", body, headers })),
  patch: (id, body, headers = SESSION) => call(dashKey.PATCH, req(`/api/management-keys/${id}`, { method: "PATCH", body, headers }), { id }),
  revoke: (id, query = "", headers = SESSION) => call(dashKey.DELETE, req(`/api/management-keys/${id}${query}`, { method: "DELETE", headers }), { id }),
  // The dashboard's own client-key edit (PUT /api/keys/[id]).
  putKey: (id, body) => call(keysRoute.PUT, req(`/api/keys/${id}`, { method: "PUT", body, headers: SESSION }), { id }),
};

let counter = 0;
async function newManagementKey(scopes, extra = {}) {
  const res = await dashboard.create({ name: `mk-${++counter}`, scopes, ...extra });
  expect(res.status).toBe(201);
  return { id: res.body.managementKey.id, secret: res.body.secret };
}

const OPENAI_ONLY = { clientKeys: { enabled: true, providers: ["openai"], maxBudgetUsd: 50 } };

// Provider secrets planted on rows, which must never come back out.
const PROVIDER_SECRETS = [];
function providerSecret(label) {
  const s = `prov-secret-${label}-${crypto.randomBytes(6).toString("hex")}`;
  PROVIDER_SECRETS.push(s);
  return s;
}

async function dashboardClientKey(name, limits = {}) {
  const created = await db.createApiKey(name, MACHINE);
  if (Object.keys(limits).length) await db.updateApiKey(created.id, limits);
  return db.getApiKeyById(created.id);
}

beforeEach(() => {
  validation.valid = true;
  validation.calls = [];
  validation.handler = null;
  delete process.env.MANAGEMENT_PROBE_TIMEOUT_MS;
});

describe("storage", () => {
  it("keeps only the sha256 of the secret, and the secret appears nowhere in the database", async () => {
    const { id, secret } = await newManagementKey(OPENAI_ONLY);
    expect(secret.startsWith("10r-mgmt-")).toBe(true);
    expect(secret.length).toBeGreaterThan(40);

    const adapter = await getAdapter();
    const row = adapter.get("SELECT * FROM managementKeys WHERE id = ?", [id]);
    expect(row.keyHash).toBe(crypto.createHash("sha256").update(secret).digest("hex"));
    expect(secret.startsWith(row.keyPrefix)).toBe(true);
    expect(row.keyPrefix.length).toBeLessThan(20);
    for (const value of Object.values(row)) expect(String(value)).not.toContain(secret);

    // Not in the database files either, WAL included.
    for (const file of fs.readdirSync(tempDir)) {
      const full = path.join(tempDir, file);
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full).includes(secret)).toBe(false);
    }

    // The dashboard list shows the prefix, never the secret or its hash.
    const list = await dashboard.list();
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(secret);
    expect(list.text).not.toContain(row.keyHash);
    expect(list.body.managementKeys.find((k) => k.id === id).keyPrefix).toBe(row.keyPrefix);
  });

  it("a fresh database has the tables and owner columns, and migration 006 is idempotent", async () => {
    const adapter = await getAdapter();
    for (const table of ["apiKeys", "providerConnections"]) {
      expect(adapter.all(`PRAGMA table_info(${table})`).map((c) => c.name)).toContain("ownerManagementKeyId");
    }
    const tables = adapter.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["managementKeys", "managementAudit"]));
    const { default: m006 } = await import("@/lib/db/migrations/006-management-keys.js");
    // Idempotent: running it again on a database that has everything changes nothing.
    expect(() => m006.up(adapter)).not.toThrow();
  });
});

describe("prefix separation", () => {
  it("rejects a client key on the management API", async () => {
    const client = await dashboardClientKey("plain client");
    expect(client.key.startsWith("sk-")).toBe(true);
    const res = await api.me(client.key);
    expect(res.status).toBe(401);
    expect((await authenticateManagementKey(req("/x", { token: client.key }))).ok).toBe(false);
  });

  it("never accepts a management key as a client key", async () => {
    const { secret } = await newManagementKey(OPENAI_ONLY);
    expect(await db.validateApiKey(secret)).toBe(false);
    expect(await db.getApiKeyPolicy(secret)).toBeNull();
  });

  it("rejects a made-up key with the right prefix, and a management key sent other than as a bearer token", async () => {
    const { secret } = await newManagementKey(OPENAI_ONLY);
    expect((await api.me(`10r-mgmt-${"x".repeat(43)}`)).status).toBe(401);
    expect((await call(me.GET, req("/api/management/v1/me", { headers: { "x-api-key": secret } }))).status).toBe(401);
    expect((await call(me.GET, req("/api/management/v1/me"))).status).toBe(401);
  });
});

describe("GET /me", () => {
  it("returns the key's own scopes and records when it was used", async () => {
    const { id, secret } = await newManagementKey(OPENAI_ONLY);
    const res = await api.me(secret);
    expect(res.status).toBe(200);
    expect(res.body.managementKey).toMatchObject({ id, scopes: { clientKeys: { enabled: true, providers: ["openai"], maxBudgetUsd: 50 } } });
    expect(res.text).not.toContain(secret);
    expect((await db.getManagementKeyById(id)).lastUsedAt).toBeTruthy();
  });
});

describe("client key scope", () => {
  it("rejects models outside its providers, bare ids, a missing allowlist and budgets over or missing the cap", async () => {
    const { secret } = await newManagementKey(OPENAI_ONLY);
    const cases = [
      [{ name: "a", allowedModels: ["anthropic/claude-opus-5-5"], budgetUsd: 10 }, /outside this management key's providers/],
      [{ name: "a", allowedModels: ["gpt-5"], budgetUsd: 10 }, /not a provider\/model id/],
      [{ name: "a", budgetUsd: 10 }, /allowedModels is required/],
      [{ name: "a", allowedModels: ["openai/gpt-5"], budgetUsd: 60 }, /above this management key's cap/],
      [{ name: "a", allowedModels: ["openai/gpt-5"] }, /budgetUsd is required/],
      [{ name: "a", allowedModels: ["openai/gpt-5", "openrouter/openai/gpt-5"], budgetUsd: 10 }, /outside this management key's providers/],
    ];
    const before = (await db.getApiKeys()).length;
    for (const [body, error] of cases) {
      const res = await api.createClient(secret, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.error).toMatch(error);
    }
    expect((await db.getApiKeys()).length).toBe(before);
  });

  it("does not let an alias or combo stand in for in-scope models", async () => {
    await db.setModelAlias("mk-fast", "openai/gpt-5");
    await db.createCombo({ name: "mk-combo", models: ["openai/gpt-5"] });
    const { secret } = await newManagementKey(OPENAI_ONLY);
    for (const name of ["mk-fast", "mk-combo"]) {
      const res = await api.createClient(secret, { name: "x", allowedModels: [name], budgetUsd: 1 });
      expect(res.status).toBe(403);
    }
  });

  it("creates a key inside its scope, with its limits and owner, and returns the full key once", async () => {
    const { id: mkId, secret } = await newManagementKey(OPENAI_ONLY);
    const res = await api.createClient(secret, { name: "team", allowedModels: ["openai/gpt-5", "OpenAI/gpt-5-mini[1m]"], budgetUsd: 50 });
    expect(res.status).toBe(201);
    expect(res.body.key.startsWith("sk-")).toBe(true);
    expect(res.body.clientKey).toMatchObject({ name: "team", budgetUsd: 50, createdByYou: true });
    const stored = await db.getApiKeyById(res.body.clientKey.id);
    expect(stored.key).toBe(res.body.key);
    expect(stored.allowedModels).toEqual(["openai/gpt-5", "OpenAI/gpt-5-mini[1m]"]);
    expect(await db.getRowOwner("clientKey", stored.id)).toBe(mkId);
    // Later reads never carry it again.
    expect((await api.getClient(secret, stored.id)).text).not.toContain(res.body.key);
    expect((await api.listClient(secret)).text).not.toContain(res.body.key);
  });

  it("enforces a models scope: only listed models, provider-qualified or the exact bare id it lists", async () => {
    const { secret } = await newManagementKey({ clientKeys: { enabled: true, models: ["openai/gpt-5", "claude-opus-5-5"] } });
    expect((await api.createClient(secret, { name: "x", allowedModels: ["openai/gpt-4"] })).status).toBe(403);
    expect((await api.createClient(secret, { name: "x", allowedModels: ["gpt-5"] })).status).toBe(403);
    expect((await api.createClient(secret, { name: "x" })).status).toBe(403);
    for (const ok of [["openai/gpt-5"], ["cc/claude-opus-5-5"], ["claude-opus-5-5"]]) {
      expect((await api.createClient(secret, { name: "x", allowedModels: ok })).status, ok[0]).toBe(201);
    }
  });

  it("rechecks the whole key on edit", async () => {
    const { secret } = await newManagementKey(OPENAI_ONLY);
    const created = await api.createClient(secret, { name: "edit me", allowedModels: ["openai/gpt-5"], budgetUsd: 20 });
    const id = created.body.clientKey.id;
    const denied = [
      [{ allowedModels: ["anthropic/claude-opus-5-5"] }, 403],
      [{ allowedModels: null }, 403],
      [{ budgetUsd: 51 }, 403],
      [{ budgetUsd: null }, 403],
      [{ resetSpend: true }, 400],
      [{ key: "sk-chosen" }, 400],
      [{ limitHold: true }, 400],
    ];
    for (const [body, status] of denied) {
      expect((await api.patchClient(secret, id, body)).status, JSON.stringify(body)).toBe(status);
    }
    const stored = await db.getApiKeyById(id);
    expect(stored).toMatchObject({ budgetUsd: 20, allowedModels: ["openai/gpt-5"] });

    const ok = await api.patchClient(secret, id, { budgetUsd: 50, name: "renamed", isActive: false, allowedModels: ["openai/gpt-5", "openai/o3"] });
    expect(ok.status).toBe(200);
    expect(await db.getApiKeyById(id)).toMatchObject({ budgetUsd: 50, name: "renamed", isActive: false, allowedModels: ["openai/gpt-5", "openai/o3"] });
  });

  it("refuses every client-key route when client keys are not in its scope", async () => {
    const { secret } = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    const own = await dashboardClientKey("someone's");
    expect((await api.listClient(secret)).status).toBe(403);
    expect((await api.createClient(secret, { name: "x" })).status).toBe(403);
    expect((await api.getClient(secret, own.id)).status).toBe(403);
    expect((await api.patchClient(secret, own.id, { name: "y" })).status).toBe(403);
    expect((await api.deleteClient(secret, own.id)).status).toBe(403);
    expect(await db.getApiKeyById(own.id)).not.toBeNull();
  });
});

describe("provider key scope", () => {
  it("adds keys only for its providers, through the dashboard's validation and create path", async () => {
    const { id: mkId, secret } = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    const before = (await db.getProviderConnections()).length;

    const outside = await api.createProvider(secret, { provider: "anthropic", apiKey: providerSecret("anthropic") });
    expect(outside.status).toBe(403);
    expect(validation.calls).toHaveLength(0);

    const apiKey = providerSecret("openai-1");
    const res = await api.createProvider(secret, { provider: "openai", apiKey, name: "pool 1" });
    expect(res.status).toBe(201);
    expect(validation.calls).toEqual([expect.objectContaining({ provider: "openai", apiKey })]);
    const conn = await db.getProviderConnectionById(res.body.providerKey.id);
    expect(conn).toMatchObject({ provider: "openai", name: "pool 1", apiKey, authType: "apikey", testStatus: "active", isActive: true });
    expect(await db.getRowOwner("providerKey", conn.id)).toBe(mkId);
    expect((await db.getProviderConnections()).length).toBe(before + 1);
  });

  it("does not add a key the provider refuses, nor take URL or proxy fields", async () => {
    const { secret } = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    const before = (await db.getProviderConnections()).length;
    validation.valid = false;
    const refused = await api.createProvider(secret, { provider: "openai", apiKey: providerSecret("refused") });
    expect(refused.status).toBe(422);
    validation.valid = true;
    for (const body of [
      { provider: "openai", apiKey: providerSecret("u1"), providerSpecificData: { baseUrl: "http://169.254.169.254" } },
      { provider: "openai", apiKey: providerSecret("u2"), connectionProxyUrl: "http://proxy.invalid" },
      { provider: "openai", apiKey: providerSecret("u3"), allowOverwrite: true },
      { provider: "openai", apiKey: providerSecret("u4"), priority: 1 },
    ]) {
      expect((await api.createProvider(secret, body)).status, JSON.stringify(Object.keys(body))).toBe(400);
    }
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("can't overwrite an existing connection by reusing its name", async () => {
    const existingKey = providerSecret("dash-existing");
    const existing = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "taken", apiKey: existingKey });
    const { secret } = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    const res = await api.createProvider(secret, { provider: "openai", apiKey: providerSecret("overwrite"), name: "taken" });
    expect(res.status).toBe(409);
    expect(res.text).not.toContain(existing.id);
    expect((await db.getProviderConnectionById(existing.id)).apiKey).toBe(existingKey);
  });

  it("refuses every provider-key route when provider keys are not in its scope", async () => {
    const conn = await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "dash-only", apiKey: providerSecret("dash-only") });
    const { secret } = await newManagementKey(OPENAI_ONLY);
    expect((await api.listProvider(secret)).status).toBe(403);
    expect((await api.createProvider(secret, { provider: "openai", apiKey: providerSecret("nope") })).status).toBe(403);
    expect((await api.getProvider(secret, conn.id)).status).toBe(403);
    expect((await api.deleteProvider(secret, conn.id)).status).toBe(403);
    expect(await db.getProviderConnectionById(conn.id)).not.toBeNull();
  });
});

describe("visibility", () => {
  it("a scoped key sees and changes only client keys it created; manageExisting widens that to keys inside its scope", async () => {
    const a = await newManagementKey(OPENAI_ONLY);
    const b = await newManagementKey(OPENAI_ONLY);
    const wide = await newManagementKey({ clientKeys: { ...OPENAI_ONLY.clientKeys, manageExisting: true } });
    const admin = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true } });

    const ka = (await api.createClient(a.secret, { name: "A's", allowedModels: ["openai/gpt-5"], budgetUsd: 5 })).body.clientKey.id;
    const kb = (await api.createClient(b.secret, { name: "B's", allowedModels: ["openai/gpt-5"], budgetUsd: 5 })).body.clientKey.id;
    const inScope = (await dashboardClientKey("dash in scope", { allowedModels: ["openai/gpt-5"], budgetUsd: 5 })).id;
    const outOfScope = (await dashboardClientKey("dash unlimited")).id;
    const overCap = (await dashboardClientKey("dash over cap", { allowedModels: ["openai/gpt-5"], budgetUsd: 500 })).id;

    const ids = async (secret) => (await api.listClient(secret)).body.clientKeys.map((k) => k.id);
    expect(await ids(a.secret)).toEqual([ka]);
    expect(await ids(b.secret)).toEqual([kb]);
    expect(await ids(wide.secret)).toEqual(expect.arrayContaining([ka, kb, inScope]));
    expect(await ids(wide.secret)).not.toEqual(expect.arrayContaining([outOfScope]));
    expect(await ids(wide.secret)).not.toContain(overCap);
    expect(await ids(admin.secret)).toEqual(expect.arrayContaining([ka, kb, inScope, outOfScope, overCap]));

    // A can't read, edit or delete B's key or the dashboard's: 404, and nothing changes.
    for (const id of [kb, inScope, outOfScope]) {
      expect((await api.getClient(a.secret, id)).status).toBe(404);
      expect((await api.patchClient(a.secret, id, { name: "hijacked" })).status).toBe(404);
      expect((await api.deleteClient(a.secret, id)).status).toBe(404);
      expect((await db.getApiKeyById(id)).name).not.toBe("hijacked");
    }
    // manageExisting reaches in-scope keys it didn't create, not out-of-scope ones.
    expect((await api.patchClient(wide.secret, inScope, { name: "tidied" })).status).toBe(200);
    expect((await api.deleteClient(wide.secret, outOfScope)).status).toBe(404);
    expect((await api.deleteClient(wide.secret, kb)).status).toBe(200);
    expect(await db.getApiKeyById(kb)).toBeNull();
    // The owner deletes its own.
    expect((await api.deleteClient(a.secret, ka)).status).toBe(200);
    expect(await db.getApiKeyById(ka)).toBeNull();
  });

  it("narrowing a scope hides keys created under the old one", async () => {
    const mk = await newManagementKey({ clientKeys: { enabled: true, providers: ["openai", "anthropic"] } });
    const id = (await api.createClient(mk.secret, { name: "anthropic one", allowedModels: ["anthropic/claude-opus-5-5"] })).body.clientKey.id;
    expect((await api.getClient(mk.secret, id)).status).toBe(200);
    expect((await dashboard.patch(mk.id, { scopes: { clientKeys: { enabled: true, providers: ["openai"] } } })).status).toBe(200);
    expect((await api.getClient(mk.secret, id)).status).toBe(404);
    expect((await api.deleteClient(mk.secret, id)).status).toBe(404);
  });

  it("a scoped key sees only provider keys it added; manageExisting widens that to its providers", async () => {
    const scope = { enabled: true, providers: ["openai"] };
    const a = await newManagementKey({ providerKeys: scope });
    const b = await newManagementKey({ providerKeys: scope });
    const wide = await newManagementKey({ providerKeys: { ...scope, manageExisting: true } });

    const pa = (await api.createProvider(a.secret, { provider: "openai", apiKey: providerSecret("pa"), name: "A pool" })).body.providerKey.id;
    const pb = (await api.createProvider(b.secret, { provider: "openai", apiKey: providerSecret("pb"), name: "B pool" })).body.providerKey.id;
    const dashOpenai = (await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "dash openai", apiKey: providerSecret("dash-openai") })).id;
    const dashAnthropic = (await db.createProviderConnection({ provider: "anthropic", authType: "apikey", name: "dash anthropic", apiKey: providerSecret("dash-anthropic") })).id;
    const oauth = (await db.createProviderConnection({
      provider: "openai", authType: "oauth", email: "someone@example.com",
      accessToken: providerSecret("access"), refreshToken: providerSecret("refresh"), idToken: providerSecret("id"),
      providerSpecificData: { chatgptAccountId: providerSecret("psd") },
    })).id;

    const ids = async (secret, query) => (await api.listProvider(secret, query)).body.providerKeys.map((k) => k.id);
    expect(await ids(a.secret)).toEqual([pa]);
    expect(await ids(b.secret)).toEqual([pb]);
    const wideIds = await ids(wide.secret);
    expect(wideIds).toEqual(expect.arrayContaining([pa, pb, dashOpenai]));
    expect(wideIds).not.toContain(dashAnthropic);
    // An OAuth login is never reachable, even with manageExisting.
    expect(wideIds).not.toContain(oauth);
    expect((await api.getProvider(wide.secret, oauth)).status).toBe(404);
    expect((await api.deleteProvider(wide.secret, oauth)).status).toBe(404);
    expect(await db.getProviderConnectionById(oauth)).not.toBeNull();
    expect(await ids(wide.secret, "?provider=anthropic")).toEqual([]);

    for (const id of [pb, dashOpenai, dashAnthropic]) {
      expect((await api.getProvider(a.secret, id)).status).toBe(404);
      expect((await api.deleteProvider(a.secret, id)).status).toBe(404);
      expect(await db.getProviderConnectionById(id)).not.toBeNull();
    }
    expect((await api.deleteProvider(wide.secret, dashAnthropic)).status).toBe(404);
    expect((await api.deleteProvider(wide.secret, dashOpenai)).status).toBe(200);
    expect((await api.deleteProvider(a.secret, pa)).status).toBe(200);
    expect(await db.getProviderConnectionById(pa)).toBeNull();
  });
});

describe("expiry and revocation", () => {
  it("an expired, turned-off or revoked key stops working at once", async () => {
    const expired = await newManagementKey(OPENAI_ONLY, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await api.me(expired.secret)).status).toBe(401);
    expect((await api.createClient(expired.secret, { name: "x", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).status).toBe(401);

    const future = await newManagementKey(OPENAI_ONLY, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await api.me(future.secret)).status).toBe(200);

    const mk = await newManagementKey(OPENAI_ONLY);
    const kid = (await api.createClient(mk.secret, { name: "survivor", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    expect((await dashboard.patch(mk.id, { isActive: false })).status).toBe(200);
    expect((await api.me(mk.secret)).status).toBe(401);
    expect((await api.deleteClient(mk.secret, kid)).status).toBe(401);
    expect((await dashboard.patch(mk.id, { isActive: true })).status).toBe(200);
    expect((await api.me(mk.secret)).status).toBe(200);
    expect((await dashboard.patch(mk.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(200);
    expect((await api.me(mk.secret)).status).toBe(401);
    expect((await dashboard.patch(mk.id, { expiresAt: null })).status).toBe(200);
    expect((await api.me(mk.secret)).status).toBe(200);

    expect((await dashboard.revoke(mk.id)).status).toBe(200);
    expect((await api.me(mk.secret)).status).toBe(401);
    expect((await api.listClient(mk.secret)).status).toBe(401);
    // Its keys outlive it.
    expect(await db.getApiKeyById(kid)).not.toBeNull();
  });
});

describe("no management-key CRUD through the management API", () => {
  const root = fileURLToPath(new URL("../../src/app/api/management/v1", import.meta.url));
  const routeFiles = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
    return out.sort();
  };

  it("has exactly the documented routes and methods, and none reaches the dashboard's management-key handlers", async () => {
    const expected = {
      "client-keys/[id]/route.js": ["DELETE", "GET", "PATCH"],
      "client-keys/route.js": ["GET", "POST"],
      "me/route.js": ["GET"],
      "provider-keys/[id]/route.js": ["DELETE", "GET"],
      "provider-keys/route.js": ["GET", "POST"],
    };
    expect(routeFiles()).toEqual(Object.keys(expected).sort());
    const HTTP = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
    for (const [file, methods] of Object.entries(expected)) {
      const mod = await import(path.join(root, file));
      expect(Object.keys(mod).filter((k) => HTTP.has(k)).sort(), file).toEqual(methods);
      const src = fs.readFileSync(path.join(root, file), "utf8");
      expect(src, file).not.toMatch(/dashboardHandlers|managementKeysRepo|createScopedManagementKey|updateManagementKey|deleteManagementKey/);
    }
    expect(fs.readFileSync(fileURLToPath(new URL("../../src/lib/management/handlers.js", import.meta.url)), "utf8"))
      .not.toMatch(/dashboardHandlers|createScopedManagementKey|updateManagementKey|deleteManagementKey/);
    expect(Object.keys(handlers).filter((k) => typeof handlers[k] === "function").sort()).toEqual([
      "createClientKey", "createProviderKey", "getClientKey", "getMe", "getProviderKey",
      "listClientKeys", "listProviderKeys", "removeClientKey", "removeProviderKey", "updateClientKey",
    ]);
  });

  it("can't change its own scopes through a client-key route", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const res = await api.patchClient(mk.secret, mk.id, { scopes: { clientKeys: { enabled: true, manageExisting: true } } });
    expect(res.status).toBe(404);
    expect((await db.getManagementKeyById(mk.id)).scopes.clientKeys.manageExisting).toBe(false);
  });
});

describe("audit log", () => {
  it("records what each key did and was refused, without secrets", async () => {
    const mk = await newManagementKey({ clientKeys: OPENAI_ONLY.clientKeys, providerKeys: { enabled: true, providers: ["openai"] } });
    const created = await api.createClient(mk.secret, { name: "audited", allowedModels: ["openai/gpt-5"], budgetUsd: 3 });
    const kid = created.body.clientKey.id;
    await api.patchClient(mk.secret, kid, { budgetUsd: 4 });
    await api.createClient(mk.secret, { name: "too rich", allowedModels: ["openai/gpt-5"], budgetUsd: 99 });
    const apiKey = providerSecret("audited");
    const pid = (await api.createProvider(mk.secret, { provider: "openai", apiKey, name: "audited pool" })).body.providerKey.id;
    await api.createProvider(mk.secret, { provider: "anthropic", apiKey: providerSecret("audit-denied") });
    await api.deleteProvider(mk.secret, pid);
    await api.deleteClient(mk.secret, kid);

    const rows = await db.getManagementAudit({ managementKeyId: mk.id, limit: 100 });
    const actions = rows.map((r) => `${r.action}:${r.targetId ?? ""}`).reverse();
    expect(actions).toEqual([
      `management_key.create:${mk.id}`,
      `client_key.create:${kid}`,
      `client_key.update:${kid}`,
      "client_key.create.denied:",
      `provider_key.create:${pid}`,
      "provider_key.create.denied:",
      `provider_key.delete:${pid}`,
      `client_key.delete:${kid}`,
    ]);
    expect(rows.find((r) => r.action === "client_key.create.denied").detail.reason).toMatch(/cap/);
    expect(rows.every((r) => typeof r.at === "string" && r.managementKeyId === mk.id)).toBe(true);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(created.body.key);
    expect(raw).not.toContain(apiKey);
    expect(raw).not.toContain(mk.secret);

    // The dashboard shows the recent entries.
    const list = await dashboard.list();
    expect(list.body.audit.some((r) => r.managementKeyId === mk.id && r.action === "client_key.delete")).toBe(true);
  });

  it("shows on the dashboard which keys each management key created", async () => {
    const mk = await newManagementKey({ clientKeys: OPENAI_ONLY.clientKeys, providerKeys: { enabled: true, providers: ["openai"] } });
    const kid = (await api.createClient(mk.secret, { name: "listed", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const pid = (await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("listed"), name: "listed pool" })).body.providerKey.id;
    const list = await dashboard.list();
    const entry = list.body.managementKeys.find((k) => k.id === mk.id);
    expect(entry.created.clientKeys.map((k) => k.id)).toEqual([kid]);
    expect(entry.created.providerKeys.map((k) => k.id)).toEqual([pid]);
  });
});

describe("dashboard validation of management keys", () => {
  it("refuses empty scopes, unknown providers and bad fields", async () => {
    expect((await dashboard.create({ name: "x", scopes: {} })).status).toBe(400);
    expect((await dashboard.create({ name: "x", scopes: { clientKeys: { enabled: true, providers: ["no-such-provider"] } } })).status).toBe(400);
    expect((await dashboard.create({ name: "x", scopes: { clientKeys: { enabled: true, providers: [] } } })).status).toBe(400);
    expect((await dashboard.create({ name: "x", scopes: { clientKeys: { enabled: true, maxBudgetUsd: -1 } } })).status).toBe(400);
    expect((await dashboard.create({ name: "", scopes: OPENAI_ONLY })).status).toBe(400);
    expect((await dashboard.create({ name: "x", scopes: OPENAI_ONLY, expiresAt: "not a date" })).status).toBe(400);
  });
});

describe("dashboard routes check the session themselves", () => {
  it("refuse every management-keys route without a session, whatever the proxy did", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const none = {};
    const bad = { cookie: "auth_token=forged" };
    for (const headers of [none, bad]) {
      expect((await dashboard.list(headers)).status).toBe(401);
      expect((await dashboard.create({ name: "x", scopes: OPENAI_ONLY }, headers)).status).toBe(401);
      expect((await dashboard.patch(mk.id, { isActive: false }, headers)).status).toBe(401);
      expect((await dashboard.revoke(mk.id, "", headers)).status).toBe(401);
    }
    expect((await api.me(mk.secret)).status).toBe(200);
  });
});

describe("stored scopes fail closed", () => {
  it("a scopes column that is not valid JSON, or has the wrong types, grants nothing", async () => {
    const adapter = await getAdapter();
    for (const raw of ["{not json", JSON.stringify({ clientKeys: { enabled: "yes", manageExisting: true } }), JSON.stringify({ clientKeys: { enabled: true, providers: "openai" } }), "null", "[]"]) {
      const mk = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true }, providerKeys: { enabled: true, manageExisting: true } });
      adapter.run("UPDATE managementKeys SET scopes = ? WHERE id = ?", [raw, mk.id]);
      const me = await api.me(mk.secret);
      expect(me.status, raw).toBe(200);
      expect(me.body.managementKey.scopes.clientKeys.enabled, raw).toBe(false);
      expect(me.body.managementKey.scopes.providerKeys.enabled, raw).toBe(false);
      expect((await api.listClient(mk.secret)).status, raw).toBe(403);
      expect((await api.listProvider(mk.secret)).status, raw).toBe(403);
    }
  });
});

describe("client key masking", () => {
  it("shows at most a third of a key, so a short legacy key shows none of its random part", () => {
    expect(maskClientKey("sk-abcdefgh")).toBe("sk-…");
    expect(maskClientKey("sk-machine-test-0001-abcdef-12345678")).toBe("sk-machi…");
    for (const k of ["sk-abcdefgh", "sk-12345678901", "sk-machine-test-0001-abcdef-12345678"]) {
      expect(maskClientKey(k).length - 1).toBeLessThanOrEqual(Math.floor(k.length / 3));
    }
  });

  it("lists a short legacy key masked", async () => {
    const adapter = await getAdapter();
    adapter.run(`INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES('legacy-1', 'sk-q7w8e9r0', 'legacy', NULL, 1, '2026-01-01T00:00:00.000Z')`);
    const admin = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true } });
    const res = await api.getClient(admin.secret, "legacy-1");
    expect(res.status).toBe(200);
    expect(res.body.clientKey.keyPreview).toBe("sk-…");
    expect(res.text).not.toMatch(/q7w8|e9r0/);
  });
});

describe("the dashboard's choices stand", () => {
  it("a management key can't turn back on a key the dashboard turned off, but can undo its own", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "toggle", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    expect((await dashboard.putKey(id, { isActive: false })).status).toBe(200);
    const refused = await api.patchClient(mk.secret, id, { isActive: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/turned off in the dashboard/);
    expect((await db.getApiKeyById(id)).isActive).toBe(false);

    expect((await dashboard.putKey(id, { isActive: true })).status).toBe(200);
    expect((await api.patchClient(mk.secret, id, { isActive: false })).status).toBe(200);
    expect((await api.patchClient(mk.secret, id, { isActive: true })).status).toBe(200);
    expect((await db.getApiKeyById(id)).isActive).toBe(true);

    // The management key turns it off, then the dashboard takes over: the dashboard's choice wins.
    expect((await api.patchClient(mk.secret, id, { isActive: false })).status).toBe(200);
    expect((await dashboard.putKey(id, { isActive: true })).status).toBe(200);
    expect((await dashboard.putKey(id, { isActive: false })).status).toBe(200);
    expect((await api.patchClient(mk.secret, id, { isActive: true })).status).toBe(403);
  });

  it("an expiry the management key set becomes the dashboard's once the dashboard changes it", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "handed over", allowedModels: ["openai/gpt-5"], budgetUsd: 1, expiresAt: "2027-01-01T00:00:00.000Z" })).body.clientKey.id;
    expect((await dashboard.putKey(id, { expiresAt: "2027-02-01T00:00:00.000Z" })).status).toBe(200);
    expect((await api.patchClient(mk.secret, id, { expiresAt: null })).status).toBe(403);
  });

  it("a key off with no recorded actor (from before the record) counts as the dashboard's", async () => {
    const admin = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true } });
    const old = await dashboardClientKey("old and off");
    await db.updateApiKey(old.id, { isActive: false });
    expect((await api.patchClient(admin.secret, old.id, { isActive: true })).status).toBe(403);
  });

  it("an expiry the dashboard set can only be moved earlier", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "expiring", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const set = "2027-06-01T00:00:00.000Z";
    expect((await dashboard.putKey(id, { expiresAt: set })).status).toBe(200);
    expect((await api.patchClient(mk.secret, id, { expiresAt: null })).status).toBe(403);
    expect((await api.patchClient(mk.secret, id, { expiresAt: "2027-07-01T00:00:00.000Z" })).status).toBe(403);
    expect((await db.getApiKeyById(id)).expiresAt).toBe(set);
    expect((await api.patchClient(mk.secret, id, { expiresAt: "2027-05-01T00:00:00.000Z" })).status).toBe(200);
    // Its own expiry it can move freely.
    const own = (await api.createClient(mk.secret, { name: "own expiry", allowedModels: ["openai/gpt-5"], budgetUsd: 1, expiresAt: set })).body.clientKey.id;
    expect((await api.patchClient(mk.secret, own, { expiresAt: null })).status).toBe(200);
  });
});

describe("revoking keeps or deletes what a key made", () => {
  it("plain revoke keeps the rows, marked as made by a deleted key; deleteCreated removes them later", async () => {
    const mk = await newManagementKey({ clientKeys: OPENAI_ONLY.clientKeys, providerKeys: { enabled: true, providers: ["openai"] } });
    const kid = (await api.createClient(mk.secret, { name: "left behind", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const pid = (await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("left"), name: "left pool" })).body.providerKey.id;
    expect((await dashboard.revoke(mk.id)).status).toBe(200);
    expect((await db.getApiKeyById(kid)).ownerManagementKeyId).toBe(mk.id);
    expect(await db.getRowOwner("providerKey", pid)).toBe(mk.id);

    const list = await dashboard.list();
    const orphan = list.body.orphans.find((o) => o.managementKeyId === mk.id);
    expect(orphan).toMatchObject({ clientKeyCount: 1, providerKeyCount: 1 });
    expect(orphan.clientKeys.map((k) => k.id)).toEqual([kid]);

    const cleaned = await dashboard.revoke(mk.id, "?deleteCreated=1");
    expect(cleaned.body).toMatchObject({ deletedClientKeys: 1, deletedProviderKeys: 1 });
    expect(await db.getApiKeyById(kid)).toBeNull();
    expect(await db.getProviderConnectionById(pid)).toBeNull();
    expect((await dashboard.list()).body.orphans.find((o) => o.managementKeyId === mk.id)).toBeUndefined();
    expect((await dashboard.revoke(mk.id, "?deleteCreated=1")).status).toBe(404);
  });

  it("revoke with deleteCreated takes the key and everything it made, and nothing else", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const other = await newManagementKey(OPENAI_ONLY);
    const mine = (await api.createClient(mk.secret, { name: "mine", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const theirs = (await api.createClient(other.secret, { name: "theirs", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const dash = (await dashboardClientKey("dash")).id;
    expect((await dashboard.revoke(mk.id, "?deleteCreated=1")).status).toBe(200);
    expect((await api.me(mk.secret)).status).toBe(401);
    expect(await db.getApiKeyById(mine)).toBeNull();
    expect(await db.getApiKeyById(theirs)).not.toBeNull();
    expect(await db.getApiKeyById(dash)).not.toBeNull();
  });
});

describe("provider key validation on the management path", () => {
  const scope = { providerKeys: { enabled: true, providers: ["openai"] } };

  it("gives up on a probe that doesn't answer with a 504, and adds nothing", async () => {
    const mk = await newManagementKey(scope);
    const before = (await db.getProviderConnections()).length;
    process.env.MANAGEMENT_PROBE_TIMEOUT_MS = "50";
    validation.handler = () => new Promise(() => {});
    const res = await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("hang"), name: "hang" });
    expect(res.status).toBe(504);
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("passes on the validator's own error status, and adds nothing", async () => {
    const mk = await newManagementKey(scope);
    const before = (await db.getProviderConnections()).length;
    validation.handler = () => Response.json({ error: "OpenAI Compatible node not found" }, { status: 404 });
    const res = await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("404"), name: "404" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("OpenAI Compatible node not found");
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("checks the key again after the probe: revoked or narrowed meanwhile adds nothing", async () => {
    const before = (await db.getProviderConnections()).length;
    const revoked = await newManagementKey(scope);
    validation.handler = async () => {
      await db.deleteManagementKey(revoked.id);
      return Response.json({ valid: true });
    };
    expect((await api.createProvider(revoked.secret, { provider: "openai", apiKey: providerSecret("race1"), name: "race1" })).status).toBe(401);

    const narrowed = await newManagementKey(scope);
    validation.handler = async () => {
      await db.updateManagementKey(narrowed.id, { scopes: { ...(await db.getManagementKeyById(narrowed.id)).scopes, providerKeys: { enabled: true, providers: ["anthropic"], manageExisting: false } } });
      return Response.json({ valid: true });
    };
    expect((await api.createProvider(narrowed.secret, { provider: "openai", apiKey: providerSecret("race2"), name: "race2" })).status).toBe(403);
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("refuses an oversized key and a session-cookie provider before probing", async () => {
    const mk = await newManagementKey({ providerKeys: { enabled: true } });
    const big = await api.createProvider(mk.secret, { provider: "openai", apiKey: "k".repeat(8193) });
    expect(big.status).toBe(400);
    expect(big.body.error).toMatch(/at most 8192/);
    const cookie = await api.createProvider(mk.secret, { provider: "grok-web", apiKey: providerSecret("cookie") });
    expect(cookie.status).toBe(400);
    expect(validation.calls).toHaveLength(0);
  });
});

describe("audit log under abuse", () => {
  it("6000 refusals leave the earlier real trail intact", async () => {
    const { AUDIT_KEEP_DENIED } = await import("@/lib/db/repos/managementKeysRepo.js");
    const mk = await newManagementKey(OPENAI_ONLY);
    const kid = (await api.createClient(mk.secret, { name: "before the flood", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    // One refusal through the API, flagged as one.
    await api.createClient(mk.secret, { name: "x", allowedModels: ["anthropic/claude-opus-5-5"], budgetUsd: 1 });
    const adapter = await getAdapter();
    expect(adapter.get("SELECT denied FROM managementAudit WHERE managementKeyId = ? AND action = 'client_key.create.denied'", [mk.id]).denied).toBe(1);

    for (let i = 0; i < 6000; i++) {
      await db.addManagementAudit({ managementKeyId: mk.id, action: "client_key.create.denied", targetType: "clientKey", detail: { reason: `flood ${i}` }, denied: true });
    }
    const real = adapter.all("SELECT action, targetId FROM managementAudit WHERE managementKeyId = ? AND denied = 0", [mk.id]);
    expect(real).toEqual(expect.arrayContaining([
      { action: "management_key.create", targetId: mk.id },
      { action: "client_key.create", targetId: kid },
    ]));
    expect(adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE denied = 1").n).toBe(AUDIT_KEEP_DENIED);
  });

  it("keeps a refusal's detail compact and every detail under the cap", async () => {
    const { AUDIT_DETAIL_MAX } = await import("@/lib/db/repos/managementKeysRepo.js");
    const mk = await newManagementKey(OPENAI_ONLY);
    const models = Array.from({ length: 400 }, (_, i) => `anthropic/${"m".repeat(280)}${i}`);
    expect((await api.createClient(mk.secret, { name: "n".repeat(120), allowedModels: models, budgetUsd: 1 })).status).toBe(403);
    const adapter = await getAdapter();
    const row = adapter.get("SELECT detail FROM managementAudit WHERE managementKeyId = ? AND denied = 1 ORDER BY id DESC", [mk.id]);
    expect(row.detail.length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX);
    const detail = JSON.parse(row.detail);
    expect(detail.allowedModels).toHaveLength(3);
    expect(detail.allowedModelsCount).toBe(400);
    expect(detail.allowedModels[0].length).toBeLessThanOrEqual(101);

    await db.addManagementAudit({ managementKeyId: mk.id, action: "x", detail: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "v".repeat(300)])) });
    const big = adapter.get("SELECT detail FROM managementAudit WHERE managementKeyId = ? AND action = 'x'", [mk.id]);
    expect(big.detail.length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX);
  });

  it("the dashboard list is bounded", async () => {
    const { DASHBOARD_AUDIT_LIMIT, DASHBOARD_CREATED_LIMIT } = await import("@/lib/management/dashboardHandlers.js");
    const mk = await newManagementKey({ clientKeys: { enabled: true } });
    for (let i = 0; i < DASHBOARD_CREATED_LIMIT + 5; i++) await api.createClient(mk.secret, { name: `bulk ${i}` });
    const list = await dashboard.list();
    expect(list.body.audit.length).toBeLessThanOrEqual(DASHBOARD_AUDIT_LIMIT);
    const entry = list.body.managementKeys.find((k) => k.id === mk.id);
    expect(entry.created.clientKeys).toHaveLength(DASHBOARD_CREATED_LIMIT);
    expect(entry.created.clientKeyCount).toBe(DASHBOARD_CREATED_LIMIT + 5);
  });
});

describe("no secrets in any response", () => {
  it("no response carries a provider secret, a full client key outside its create response, or a management secret outside its own", async () => {
    // Make sure at least one listing of everything runs last.
    const admin = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true }, providerKeys: { enabled: true, manageExisting: true } });
    await api.listClient(admin.secret);
    await api.listProvider(admin.secret);

    // Every client key ever issued, including ones deleted since.
    const allClientKeys = [...new Set([
      ...(await db.getApiKeys()).map((k) => k.key),
      ...seen.filter((s) => s.label === "POST /api/management/v1/client-keys" && s.status === 201).map((s) => JSON.parse(s.text).key),
    ])];
    const adapter = await getAdapter();
    const hashes = adapter.all("SELECT keyHash FROM managementKeys").map((r) => r.keyHash);
    expect(seen.length).toBeGreaterThan(50);
    expect(PROVIDER_SECRETS.length).toBeGreaterThan(10);

    // The dashboard's own client-key route returns full keys by design; it is not under test here.
    for (const { label, status, text } of seen.filter((s) => !s.label.startsWith("PUT /api/keys/"))) {
      for (const s of PROVIDER_SECRETS) expect(text, label).not.toContain(s);
      for (const field of ["\"apiKey\"", "\"accessToken\"", "\"refreshToken\"", "\"idToken\"", "\"providerSpecificData\"", "\"keyHash\""]) {
        expect(text, label).not.toContain(field);
      }
      for (const h of hashes) expect(text, label).not.toContain(h);

      const isClientCreate = label === "POST /api/management/v1/client-keys" && status === 201;
      const fullKeys = allClientKeys.filter((k) => text.includes(k));
      if (isClientCreate) expect(fullKeys, label).toEqual([JSON.parse(text).key]);
      else expect(fullKeys, label).toEqual([]);

      const isDashboardCreate = label === "POST /api/management-keys" && status === 201;
      const secrets = text.match(/10r-mgmt-[A-Za-z0-9_-]{20,}/g) || [];
      if (isDashboardCreate) expect(secrets, label).toEqual([JSON.parse(text).secret]);
      else expect(secrets, label).toEqual([]);
    }
  });
});
