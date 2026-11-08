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
const validation = { valid: true, calls: [] };

vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => MACHINE }));
vi.mock("@/app/api/providers/validate/route.js", () => ({
  POST: async (request) => {
    const body = await request.json();
    validation.calls.push(body);
    return Response.json({ valid: validation.valid, error: validation.valid ? null : `upstream said no to ${body.apiKey}` });
  },
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

const dashboard = {
  list: () => call(dashKeys.GET, req("/api/management-keys")),
  create: (body) => call(dashKeys.POST, req("/api/management-keys", { method: "POST", body })),
  patch: (id, body) => call(dashKey.PATCH, req(`/api/management-keys/${id}`, { method: "PATCH", body }), { id }),
  revoke: (id) => call(dashKey.DELETE, req(`/api/management-keys/${id}`, { method: "DELETE" }), { id }),
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
    expect(wideIds).toEqual(expect.arrayContaining([pa, pb, dashOpenai, oauth]));
    expect(wideIds).not.toContain(dashAnthropic);
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
  it("has exactly the documented routes, none of them for management keys", () => {
    const root = fileURLToPath(new URL("../../src/app/api/management/v1", import.meta.url));
    const routes = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else routes.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
    expect(routes.sort()).toEqual([
      "client-keys/[id]/route.js",
      "client-keys/route.js",
      "me/route.js",
      "provider-keys/[id]/route.js",
      "provider-keys/route.js",
    ]);
    expect(Object.keys(handlers).sort()).toEqual([
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

    for (const { label, status, text } of seen) {
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
