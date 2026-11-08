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
// The real DB layer, with hooks to inject a race at a chosen step.
const dbHooks = { beforeUpdateAs: null, beforeCreateOwned: null, afterClaim: null, beforeRowsOwnedBy: null };
vi.mock("@/lib/db/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateApiKeyAs: async (...a) => { if (dbHooks.beforeUpdateAs) await dbHooks.beforeUpdateAs(...a); return actual.updateApiKeyAs(...a); },
    createOwnedApiKey: async (...a) => { if (dbHooks.beforeCreateOwned) await dbHooks.beforeCreateOwned(...a); return actual.createOwnedApiKey(...a); },
    claimRowForManagementKey: async (...a) => { const r = await actual.claimRowForManagementKey(...a); if (dbHooks.afterClaim) await dbHooks.afterClaim(...a); return r; },
    getRowsOwnedBy: async (...a) => { if (dbHooks.beforeRowsOwnedBy) await dbHooks.beforeRowsOwnedBy(...a); return actual.getRowsOwnedBy(...a); },
  };
});

// The dashboard's provider create route, real, with a hook after it runs.
const providerHooks = { afterCreate: null };
vi.mock("@/app/api/providers/route.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    POST: async (request) => {
      const res = await actual.POST(request);
      if (providerHooks.afterCreate) await providerHooks.afterCreate();
      return res;
    },
  };
});
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
  providerHooks.afterCreate = null;
  for (const k of Object.keys(dbHooks)) dbHooks[k] = null;
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
  it("6000 refusals from one key leave the earlier real trail intact", async () => {
    const { AUDIT_KEEP_DENIED_PER_KEY } = await import("@/lib/db/repos/managementKeysRepo.js");
    const mk = await newManagementKey(OPENAI_ONLY);
    const kid = (await api.createClient(mk.secret, { name: "before the flood", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    // One refusal through the API, in the refusal pool.
    await api.createClient(mk.secret, { name: "x", allowedModels: ["anthropic/claude-opus-5-5"], budgetUsd: 1 });
    const adapter = await getAdapter();
    expect(adapter.get("SELECT pool FROM managementAudit WHERE managementKeyId = ? AND action = 'client_key.create.denied'", [mk.id]).pool).toBe("denied");

    for (let i = 0; i < 6000; i++) {
      await db.addManagementAudit({ managementKeyId: mk.id, action: "client_key.create.denied", targetType: "clientKey", detail: { reason: `flood ${i}` }, pool: "denied" });
    }
    const real = adapter.all("SELECT action, targetId FROM managementAudit WHERE managementKeyId = ? AND pool <> 'denied'", [mk.id]);
    expect(real).toEqual(expect.arrayContaining([
      { action: "management_key.create", targetId: mk.id },
      { action: "client_key.create", targetId: kid },
    ]));
    expect(adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE pool = 'denied' AND managementKeyId = ?", [mk.id]).n).toBe(AUDIT_KEEP_DENIED_PER_KEY);
  });

  it("6000 of one key's own operations, and its no-op edits, leave other keys' and the dashboard's rows intact", async () => {
    const { AUDIT_KEEP_PER_KEY } = await import("@/lib/db/repos/managementKeysRepo.js");
    const a = await newManagementKey(OPENAI_ONLY);
    const b = await newManagementKey(OPENAI_ONLY);
    const kb = (await api.createClient(b.secret, { name: "B's", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const ka = (await api.createClient(a.secret, { name: "A's", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const adapter = await getAdapter();
    const count = (id) => adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE managementKeyId = ?", [id]).n;

    // No-op edits change nothing and add nothing.
    const before = count(a.id);
    for (const body of [{}, { name: "A's" }, { budgetUsd: 1 }, { isActive: true }, { allowedModels: ["openai/gpt-5"] }]) {
      expect((await api.patchClient(a.secret, ka, body)).status).toBe(200);
    }
    expect(count(a.id)).toBe(before);
    const dashBefore = await dashboard.patch(a.id, { name: (await db.getManagementKeyById(a.id)).name });
    expect(dashBefore.status).toBe(200);
    expect(count(a.id)).toBe(before);

    for (let i = 0; i < 6000; i++) {
      await db.addManagementAudit({ managementKeyId: a.id, action: "client_key.update", targetType: "clientKey", targetId: ka, detail: { changed: ["name"] } });
    }
    expect(adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE managementKeyId = ? AND pool = 'ok'", [a.id]).n).toBe(AUDIT_KEEP_PER_KEY);
    // B's trail and the dashboard's rows for both keys survive.
    const bRows = adapter.all("SELECT action, targetId FROM managementAudit WHERE managementKeyId = ?", [b.id]);
    expect(bRows).toEqual(expect.arrayContaining([{ action: "management_key.create", targetId: b.id }, { action: "client_key.create", targetId: kb }]));
    expect(adapter.get("SELECT pool FROM managementAudit WHERE managementKeyId = ? AND action = 'management_key.create'", [a.id]).pool).toBe("dashboard");
  });

  it("compacts a refusal's detail, keeps a success's full lists, and keeps every detail under the cap", async () => {
    const { AUDIT_DETAIL_MAX } = await import("@/lib/db/repos/managementKeysRepo.js");
    const mk = await newManagementKey(OPENAI_ONLY);
    const adapter = await getAdapter();
    const models = Array.from({ length: 400 }, (_, i) => `anthropic/${"m".repeat(280)}${i}`);
    expect((await api.createClient(mk.secret, { name: "n".repeat(120), allowedModels: models, budgetUsd: 1 })).status).toBe(403);
    const refusal = adapter.get("SELECT detail FROM managementAudit WHERE managementKeyId = ? AND pool = 'denied' ORDER BY id DESC", [mk.id]);
    expect(refusal.detail.length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX);
    const rd = JSON.parse(refusal.detail);
    expect(rd.allowedModels).toHaveLength(3);
    expect(rd.allowedModelsCount).toBe(400);

    // A success keeps its lists in full while they fit.
    const five = ["openai/a", "openai/b", "openai/c", "openai/d", "openai/e"];
    const id = (await api.createClient(mk.secret, { name: "five", allowedModels: five, budgetUsd: 1 })).body.clientKey.id;
    await api.patchClient(mk.secret, id, { name: "renamed", isActive: false, budgetUsd: 2, allowedModels: ["openai/a"] });
    const created = JSON.parse(adapter.get("SELECT detail FROM managementAudit WHERE targetId = ? AND action = 'client_key.create'", [id]).detail);
    expect(created.allowedModels).toEqual(five);
    const edited = JSON.parse(adapter.get("SELECT detail FROM managementAudit WHERE targetId = ? AND action = 'client_key.update'", [id]).detail);
    expect(edited.changed.sort()).toEqual(["allowedModels", "budgetUsd", "isActive", "name"]);

    // Over the cap, a success falls back to counts.
    const many = Array.from({ length: 30 }, (_, i) => `openai/${"x".repeat(250)}${i}`);
    const big = (await api.createClient(mk.secret, { name: "many", allowedModels: many, budgetUsd: 1 })).body.clientKey.id;
    const bigDetail = adapter.get("SELECT detail FROM managementAudit WHERE targetId = ? AND action = 'client_key.create'", [big]).detail;
    expect(bigDetail.length).toBeLessThanOrEqual(AUDIT_DETAIL_MAX);
    expect(JSON.parse(bigDetail).allowedModelsCount).toBe(30);
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

describe("the dashboard's choices can't be taken over by repeating them", () => {
  it("a no-op turn-off followed by a turn-on stays refused", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "no-op off", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    expect((await dashboard.putKey(id, { isActive: false })).status).toBe(200);
    expect((await api.patchClient(mk.secret, id, { isActive: false })).status).toBe(200);
    expect((await db.getApiKeyById(id)).disabledBy).toBe("dashboard");
    expect((await api.patchClient(mk.secret, id, { isActive: true })).status).toBe(403);
    expect((await db.getApiKeyById(id)).isActive).toBe(false);
  });

  it("the same or an earlier expiry followed by clearing it stays refused", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "no-op expiry", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const set = "2027-06-01T00:00:00.000Z";
    expect((await dashboard.putKey(id, { expiresAt: set })).status).toBe(200);
    // The same instant, written another way.
    expect((await api.patchClient(mk.secret, id, { expiresAt: "2027-06-01T00:00:00Z" })).status).toBe(200);
    expect((await db.getApiKeyById(id)).expiresAtSetBy).toBe("dashboard");
    expect((await api.patchClient(mk.secret, id, { expiresAt: null })).status).toBe(403);
    // Earlier is allowed, and the expiry stays the dashboard's.
    expect((await api.patchClient(mk.secret, id, { expiresAt: "2027-05-01T00:00:00.000Z" })).status).toBe(200);
    expect((await db.getApiKeyById(id)).expiresAtSetBy).toBe("dashboard");
    expect((await api.patchClient(mk.secret, id, { expiresAt: null })).status).toBe(403);
    expect((await api.patchClient(mk.secret, id, { expiresAt: set })).status).toBe(403);
    expect((await db.getApiKeyById(id)).expiresAt).toBe("2027-05-01T00:00:00.000Z");
  });

  it("the dashboard saving a key's other limits doesn't take over an expiry a management key set", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const set = "2027-06-01T00:00:00.000Z";
    const id = (await api.createClient(mk.secret, { name: "kept", allowedModels: ["openai/gpt-5"], budgetUsd: 1, expiresAt: set })).body.clientKey.id;
    expect((await dashboard.putKey(id, { budgetUsd: 2, expiresAt: set })).status).toBe(200);
    expect((await db.getApiKeyById(id)).expiresAtSetBy).toBe(mk.id);
    expect((await api.patchClient(mk.secret, id, { expiresAt: null })).status).toBe(200);
  });
});

describe("nextKeyActors, the rule behind the dashboard's last word", () => {
  it("never hands the dashboard's choice to a management key, even on a no-op or a stale record", async () => {
    const { nextKeyActors } = await import("@/lib/db/repos/managementKeysRepo.js");
    const off = { isActive: false, disabledBy: "dashboard", expiresAt: null, expiresAtSetBy: null };
    expect(nextKeyActors(off, { isActive: false }, "mk-1").disabledBy).toBe("dashboard");
    // A stale "dashboard" on a key that is on: a management key turning it off doesn't take it.
    expect(nextKeyActors({ isActive: true, disabledBy: "dashboard" }, { isActive: false }, "mk-1").disabledBy).toBe("dashboard");
    expect(nextKeyActors({ isActive: true, disabledBy: null }, { isActive: false }, "mk-1").disabledBy).toBe("mk-1");
    expect(nextKeyActors({ isActive: false, disabledBy: "mk-1" }, { isActive: true }, "mk-1").disabledBy).toBeNull();
    // Legacy: off with no record counts as the dashboard's.
    expect(nextKeyActors({ isActive: false, disabledBy: null }, { isActive: false }, "mk-1").disabledBy).toBe("dashboard");

    const exp = { isActive: true, expiresAt: "2027-06-01T00:00:00.000Z", expiresAtSetBy: "dashboard" };
    expect(nextKeyActors(exp, { expiresAt: "2027-06-01T00:00:00Z" }, "mk-1").expiresAtSetBy).toBe("dashboard");
    expect(nextKeyActors(exp, { expiresAt: "2027-05-01T00:00:00.000Z" }, "mk-1").expiresAtSetBy).toBe("dashboard");
    expect(nextKeyActors({ isActive: true, expiresAt: null }, { expiresAt: "2027-05-01T00:00:00.000Z" }, "mk-1").expiresAtSetBy).toBe("mk-1");
    expect(nextKeyActors({ isActive: true, expiresAt: "2027-05-01T00:00:00.000Z", expiresAtSetBy: "mk-1" }, { expiresAt: null }, "mk-1").expiresAtSetBy).toBeNull();
    // The dashboard takes over whatever it sets.
    expect(nextKeyActors({ isActive: false, disabledBy: "mk-1" }, { isActive: false }, "dashboard").disabledBy).toBe("dashboard");
    expect(nextKeyActors({ isActive: true, expiresAt: "2027-05-01T00:00:00.000Z", expiresAtSetBy: "mk-1" }, { expiresAt: "2027-04-01T00:00:00.000Z" }, "dashboard").expiresAtSetBy).toBe("dashboard");
  });
});

describe("ownership claims are atomic", () => {
  it("a client key isn't created for a key revoked mid-request", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const before = (await db.getApiKeys()).length;
    await db.deleteManagementKey(mk.id);
    const created = await db.createOwnedApiKey({ name: "late", machineId: MACHINE, limits: {}, ownerId: mk.id });
    expect(created).toBeNull();
    expect((await db.getApiKeys()).length).toBe(before);
  });

  it("a provider key whose owner can't be claimed (key revoked after the create) is removed again", async () => {
    const mk = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    const before = (await db.getProviderConnections()).length;
    providerHooks.afterCreate = () => db.deleteManagementKey(mk.id);
    const res = await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("late"), name: "late pool" });
    expect(res.status).toBe(401);
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("revoke-and-delete removes the key before sweeping, so nothing it makes afterwards survives", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    await api.createClient(mk.secret, { name: "made", allowedModels: ["openai/gpt-5"], budgetUsd: 1 });
    expect((await dashboard.revoke(mk.id, "?deleteCreated=1")).body.deletedClientKeys).toBe(1);
    expect(await db.createOwnedApiKey({ name: "after", machineId: MACHINE, limits: {}, ownerId: mk.id })).toBeNull();
    expect(await db.getRowsOwnedBy("clientKey", mk.id)).toEqual([]);
  });
});

describe("an admin replacing a provider key's secret takes it over", () => {
  it("clears the owner on edit and on overwrite, so the management key can no longer see or delete it", async () => {
    const mk = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    const edited = (await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("own1"), name: "to edit" })).body.providerKey.id;
    const overwritten = (await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("own2"), name: "to overwrite" })).body.providerKey.id;

    const adminKey = providerSecret("admin-edit");
    await db.updateProviderConnection(edited, { apiKey: adminKey });
    await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "to overwrite", apiKey: providerSecret("admin-overwrite"), allowOverwrite: true });
    for (const id of [edited, overwritten]) {
      expect(await db.getRowOwner("providerKey", id)).toBeNull();
      expect((await api.getProvider(mk.secret, id)).status).toBe(404);
      expect((await api.deleteProvider(mk.secret, id)).status).toBe(404);
      expect(await db.getProviderConnectionById(id)).not.toBeNull();
    }

    // Other updates (a status stamp, the same key again) keep the owner.
    const kept = (await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("own3"), name: "kept" })).body.providerKey.id;
    const conn = await db.getProviderConnectionById(kept);
    await db.updateProviderConnection(kept, { testStatus: "active", apiKey: conn.apiKey });
    expect(await db.getRowOwner("providerKey", kept)).toBe(mk.id);
  });
});

describe("round 3: races closed inside the write", () => {
  it("an admin pausing the key between the handler's read and its write wins", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "race on", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    expect((await api.patchClient(mk.secret, id, { isActive: false })).status).toBe(200);
    // The handler reads "off by this management key", then the admin pauses it too.
    dbHooks.beforeUpdateAs = async () => { await dashboard.putKey(id, { isActive: false }); };
    const res = await api.patchClient(mk.secret, id, { isActive: true });
    expect(res.status).toBe(403);
    expect(await db.getApiKeyById(id)).toMatchObject({ isActive: false, disabledBy: "dashboard" });
  });

  it("an admin setting an expiry between the read and the write wins", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "race expiry", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    dbHooks.beforeUpdateAs = async () => { await dashboard.putKey(id, { expiresAt: "2027-01-01T00:00:00.000Z" }); };
    const res = await api.patchClient(mk.secret, id, { expiresAt: "2028-01-01T00:00:00.000Z" });
    expect(res.status).toBe(403);
    expect((await db.getApiKeyById(id)).expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("a key revoked between the read and the write changes nothing", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "race revoke", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    dbHooks.beforeUpdateAs = () => db.deleteManagementKey(mk.id);
    expect((await api.patchClient(mk.secret, id, { budgetUsd: 2 })).status).toBe(401);
    expect((await db.getApiKeyById(id)).budgetUsd).toBe(1);
  });

  it("updateApiKeyAs is one transaction: an actor write that fails rolls the edit back", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "atomic", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    const adapter = await getAdapter();
    adapter.exec(`CREATE TRIGGER mk_abort BEFORE UPDATE OF disabledBy ON apiKeys WHEN NEW.disabledBy IS NOT OLD.disabledBy BEGIN SELECT RAISE(ABORT, 'actor write failed'); END`);
    try {
      await expect(db.updateApiKeyAs(id, { budgetUsd: 9, isActive: false }, mk.id)).rejects.toThrow(/actor write failed/);
    } finally {
      adapter.exec("DROP TRIGGER mk_abort");
    }
    expect(await db.getApiKeyById(id)).toMatchObject({ budgetUsd: 1, isActive: true });
  });

  it("a client key isn't created when the key is revoked between auth and the insert (401)", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const before = (await db.getApiKeys()).length;
    dbHooks.beforeCreateOwned = () => db.deleteManagementKey(mk.id);
    const res = await api.createClient(mk.secret, { name: "too late", allowedModels: ["openai/gpt-5"], budgetUsd: 1 });
    expect(res.status).toBe(401);
    expect((await db.getApiKeys()).length).toBe(before);
  });

  it("a provider key claimed and then swept by a racing revoke-and-delete answers 401, not 500", async () => {
    const mk = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    dbHooks.afterClaim = async (_kind, rowId) => { await db.deleteProviderConnection(rowId); };
    const res = await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("swept"), name: "swept" });
    expect(res.status).toBe(401);
  });

  it("a key turned off or expired while the row is created can't claim it, and the row is removed", async () => {
    const before = (await db.getProviderConnections()).length;
    const off = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    providerHooks.afterCreate = () => db.updateManagementKey(off.id, { isActive: false });
    expect((await api.createProvider(off.secret, { provider: "openai", apiKey: providerSecret("off"), name: "off" })).status).toBe(401);
    const expired = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    providerHooks.afterCreate = () => db.updateManagementKey(expired.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await api.createProvider(expired.secret, { provider: "openai", apiKey: providerSecret("exp"), name: "exp" })).status).toBe(401);
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("revoke-and-delete deletes the key before it collects the rows", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    await api.createClient(mk.secret, { name: "swept row", allowedModels: ["openai/gpt-5"], budgetUsd: 1 });
    const order = [];
    dbHooks.beforeRowsOwnedBy = async () => { order.push((await db.getManagementKeyById(mk.id)) ? "key still there" : "key gone"); };
    expect((await dashboard.revoke(mk.id, "?deleteCreated=1")).status).toBe(200);
    expect(order).toEqual(["key gone", "key gone"]);
  });
});

describe("round 3: the legacy expiry fallback", () => {
  it("a legacy expiry moved earlier by a manageExisting key stays the dashboard's, so clearing it is refused", async () => {
    const admin = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true } });
    const old = await dashboardClientKey("legacy expiry");
    const adapter = await getAdapter();
    adapter.run("UPDATE apiKeys SET expiresAt = ?, expiresAtSetBy = NULL WHERE id = ?", ["2027-06-01T00:00:00.000Z", old.id]);
    expect((await api.patchClient(admin.secret, old.id, { expiresAt: "2027-05-01T00:00:00.000Z" })).status).toBe(200);
    expect((await db.getApiKeyById(old.id)).expiresAtSetBy).toBe("dashboard");
    expect((await api.patchClient(admin.secret, old.id, { expiresAt: null })).status).toBe(403);
  });
});

describe("round 3: audit", () => {
  it("the same expiry written two ways is a no-op with no audit row", async () => {
    const mk = await newManagementKey(OPENAI_ONLY);
    const id = (await api.createClient(mk.secret, { name: "same instant", allowedModels: ["openai/gpt-5"], budgetUsd: 1, expiresAt: "2027-06-01T00:00:00.000Z" })).body.clientKey.id;
    const adapter = await getAdapter();
    const n = () => adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE managementKeyId = ?", [mk.id]).n;
    const before = n();
    for (const same of ["2027-06-01T00:00:00Z", "2027-06-01T00:00:00.000+00:00", "2027-06-01T02:00:00+02:00"]) {
      expect((await api.patchClient(mk.secret, id, { expiresAt: same })).status).toBe(200);
    }
    expect(n()).toBe(before);
  });

  it("deletes are kept apart, so 1000+ renames don't trim them away", async () => {
    const { AUDIT_KEEP_PER_KEY } = await import("@/lib/db/repos/managementKeysRepo.js");
    const mk = await newManagementKey(OPENAI_ONLY);
    const deleted = [];
    for (let i = 0; i < 5; i++) {
      const id = (await api.createClient(mk.secret, { name: `to delete ${i}`, allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
      expect((await api.deleteClient(mk.secret, id)).status).toBe(200);
      deleted.push(id);
    }
    for (let i = 0; i < AUDIT_KEEP_PER_KEY + 100; i++) {
      await db.addManagementAudit({ managementKeyId: mk.id, action: "client_key.update", targetType: "clientKey", targetId: "x", detail: { changed: ["name"] } });
    }
    const adapter = await getAdapter();
    const kept = adapter.all("SELECT targetId FROM managementAudit WHERE managementKeyId = ? AND action = 'client_key.delete'", [mk.id]).map((r) => r.targetId);
    expect(kept.sort()).toEqual(deleted.sort());
    expect(adapter.get("SELECT pool FROM managementAudit WHERE managementKeyId = ? AND action = 'client_key.delete'", [mk.id]).pool).toBe("delete");
  });

  it("over 2000 dashboard rows trims only the dashboard pool", async () => {
    const { AUDIT_KEEP_DASHBOARD } = await import("@/lib/db/repos/managementKeysRepo.js");
    const mk = await newManagementKey(OPENAI_ONLY);
    await api.createClient(mk.secret, { name: "kept through the dashboard flood", allowedModels: ["openai/gpt-5"], budgetUsd: 1 });
    const adapter = await getAdapter();
    const keyRows = adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE pool <> 'dashboard'").n;
    for (let i = 0; i < AUDIT_KEEP_DASHBOARD + 50; i++) {
      await db.addManagementAudit({ managementKeyId: mk.id, action: "management_key.update", targetType: "managementKey", targetId: mk.id, pool: "dashboard" });
    }
    expect(adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE pool = 'dashboard'").n).toBe(AUDIT_KEEP_DASHBOARD);
    expect(adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE pool <> 'dashboard'").n).toBe(keyRows);
  });
});

describe("round 3: backups keep ownership, never invent it", () => {
  it("a round trip keeps owners and actors for management keys this install has, and drops the rest", async () => {
    const mk = await newManagementKey({ clientKeys: OPENAI_ONLY.clientKeys, providerKeys: { enabled: true, providers: ["openai"] } });
    const kid = (await api.createClient(mk.secret, { name: "backed up", allowedModels: ["openai/gpt-5"], budgetUsd: 1, expiresAt: "2027-01-01T00:00:00.000Z" })).body.clientKey.id;
    expect((await api.patchClient(mk.secret, kid, { isActive: false })).status).toBe(200);
    const pid = (await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("backup"), name: "backed up pool" })).body.providerKey.id;
    const paused = (await dashboardClientKey("dash paused")).id;
    expect((await dashboard.putKey(paused, { isActive: false })).status).toBe(200);

    const backup = JSON.parse(JSON.stringify(await db.exportDb()));
    expect(backup.providerConnections.find((c) => c.id === pid).ownerManagementKeyId).toBe(mk.id);
    await db.importDb(backup);
    expect(await db.getApiKeyById(kid)).toMatchObject({ ownerManagementKeyId: mk.id, disabledBy: mk.id, expiresAtSetBy: mk.id });
    expect(await db.getRowOwner("providerKey", pid)).toBe(mk.id);
    expect((await db.getApiKeyById(paused)).disabledBy).toBe("dashboard");
    // The owner column stays out of the connection's data JSON.
    const adapter = await getAdapter();
    expect(adapter.get("SELECT data FROM providerConnections WHERE id = ?", [pid]).data).not.toContain("ownerManagementKeyId");
    expect((await api.getClient(mk.secret, kid)).status).toBe(200);

    // A backup naming a management key this install doesn't have: ownership dropped.
    await db.deleteManagementKey(mk.id);
    await db.importDb(backup);
    expect(await db.getApiKeyById(kid)).toMatchObject({ ownerManagementKeyId: null, disabledBy: null, expiresAtSetBy: null });
    expect(await db.getRowOwner("providerKey", pid)).toBeNull();
    expect((await db.getApiKeyById(paused)).disabledBy).toBe("dashboard");
  });
});

describe("round 3: the dashboard's provider edit route releases the owner", () => {
  it("PUT /api/providers/[id] with a new secret clears the management key's ownership", async () => {
    const mk = await newManagementKey({ providerKeys: { enabled: true, providers: ["openai"] } });
    const pid = (await api.createProvider(mk.secret, { provider: "openai", apiKey: providerSecret("route-own"), name: "route edit" })).body.providerKey.id;
    const { PUT } = await import("@/app/api/providers/[id]/route.js");
    const res = await call(PUT, req(`/api/providers/${pid}`, { method: "PUT", body: { apiKey: providerSecret("route-admin") }, headers: SESSION }), { id: pid });
    expect(res.status).toBe(200);
    expect(await db.getRowOwner("providerKey", pid)).toBeNull();
    expect((await api.deleteProvider(mk.secret, pid)).status).toBe(404);
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

    // The dashboard's own key and provider routes return full rows by design; they are not under test here.
    for (const { label, status, text } of seen.filter((s) => !s.label.startsWith("PUT /api/keys/") && !s.label.startsWith("PUT /api/providers/"))) {
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
