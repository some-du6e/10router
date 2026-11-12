// Management keys: scoped keys for /api/management/v1 that list, create, edit
// and delete client keys and provider keys. Runs the real route handlers on a
// throwaway database. Only the provider validation ping is stubbed, so no
// upstream is called. The guard side (which paths take a management key) is
// in management-keys-guard.test.js.
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

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
const dbHooks = { beforeUpdateAs: null, beforeCreateOwned: null, afterClaim: null, beforeRowsOwnedBy: null, beforeDeleteAs: null };
vi.mock("@/lib/db/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateApiKeyAs: async (...a) => { if (dbHooks.beforeUpdateAs) await dbHooks.beforeUpdateAs(...a); return actual.updateApiKeyAs(...a); },
    createOwnedApiKey: async (...a) => { if (dbHooks.beforeCreateOwned) await dbHooks.beforeCreateOwned(...a); return actual.createOwnedApiKey(...a); },
    claimRowForManagementKey: async (...a) => { const r = await actual.claimRowForManagementKey(...a); if (dbHooks.afterClaim) await dbHooks.afterClaim(...a); return r; },
    getRowsOwnedBy: async (...a) => { if (dbHooks.beforeRowsOwnedBy) await dbHooks.beforeRowsOwnedBy(...a); return actual.getRowsOwnedBy(...a); },
    deleteRowAsManagementKey: async (...a) => { if (dbHooks.beforeDeleteAs) await dbHooks.beforeDeleteAs(...a); return actual.deleteRowAsManagementKey(...a); },
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
// The executor's upstream fetch, real unless a test sets a handler (to see where a key is sent).
const upstream = { handler: null };
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  const wrapped = (...a) => (upstream.handler ? upstream.handler(...a) : actual.proxyAwareFetch(...a));
  return { ...actual, default: wrapped, proxyAwareFetch: wrapped };
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
const { hostPatternError, hostMatchesPattern, normalizeManagementScopes } = await import("@/shared/utils/managementKey.js");
const scopeForm = await import("../../src/app/(dashboard)/dashboard/endpoint/components/managementScopeForm.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");

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
  upstream.handler = null;
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

describe("provider keys with their own URL", () => {
  // An upstream where each key has its own host: key-a.acme.example, key-b.acme.example, ...
  const NODE = "openai-compatible-chat-acme";
  const NODE_URL = "https://api.acme.example/v1";
  // A second endpoint the same management key may manage, with hosts of its own (or none).
  const NODE_B = "openai-compatible-chat-acme-b";
  const ANODE = "anthropic-compatible-acme";
  const ANODE_URL = "https://api.acme.example/anthropic";
  const WILDCARD = ["*.acme.example"];
  let dnsSpy;

  beforeEach(async () => {
    for (const node of [
      { id: NODE, type: "openai-compatible", name: "Acme", prefix: "acme", apiType: "chat", baseUrl: NODE_URL },
      { id: NODE_B, type: "openai-compatible", name: "Acme B", prefix: "acmeb", apiType: "chat", baseUrl: "https://api-b.acme.example/v1" },
      { id: ANODE, type: "anthropic-compatible", name: "Acme Anthropic", prefix: "acmea", baseUrl: ANODE_URL },
    ]) {
      if (!(await db.getProviderNodeById(node.id))) await db.createProviderNode(node);
    }
    // The create route's SSRF check resolves the host; *.acme.example resolves nowhere, as in CI.
    dnsSpy = vi.spyOn(dns.promises, "lookup").mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
  });
  afterEach(() => dnsSpy.mockRestore());

  const hostsKey = (baseUrlHosts = { [NODE]: WILDCARD }, extra = {}) =>
    newManagementKey({ providerKeys: { enabled: true, providers: [NODE, NODE_B, ANODE], baseUrlHosts, ...extra } });
  const deniedRows = async (mkId) => (await db.getManagementAudit({ managementKeyId: mkId, limit: 100 })).filter((r) => r.action === "provider_key.create.denied");
  const scopeWith = (baseUrlHosts, providers = [NODE]) => ({ providerKeys: { enabled: true, providers, baseUrlHosts } });

  it("validates host patterns when the dashboard saves them", async () => {
    for (const good of ["api.acme.example", "*.acme.example", "*.eu.acme.example", "key-a.acme.example"]) {
      expect(hostPatternError(good), good).toBeNull();
    }
    const bad = {
      "*": /would allow any host; use \*\.acme\.example/,
      "*.example": /two labels after/,
      "acme": /two labels/,
      "API.acme.example": /lowercase/,
      "10.0.0.1": /IP address/,
      "*.0.0.1": /IP address/,
      "[::1]": /IP address/,
      "api.acme.example:8443": /port/,
      "https://api.acme.example": /not a URL/,
      "*.*.acme.example": /one wildcard/,
      "key-*.acme.example": /one wildcard/,
      "a.*.acme.example": /one wildcard/,
      "localhost": /localhost/,
      "*.localhost": /localhost/,
      "acme.example.": /label/,
      "under_score.acme.example": /label/,
    };
    for (const [pattern, why] of Object.entries(bad)) {
      expect(hostPatternError(pattern), pattern).toMatch(why);
      const res = await dashboard.create({ name: "hosts", scopes: scopeWith({ [NODE]: [pattern] }) });
      expect(res.status, pattern).toBe(400);
      expect(res.body.error, pattern).toMatch(/baseUrlHosts/);
    }
    const refused = [
      [scopeWith(WILDCARD), /must be an object/],
      [scopeWith({ [NODE]: "*.acme.example" }), /must be an array/],
      [scopeWith({ [NODE]: [42] }), /must be a non-empty string/],
      [scopeWith({ [NODE]: Array.from({ length: 51 }, (_, i) => `key-${i}.acme.example`) }), /at most 50 patterns/],
      // Only a custom compatible endpoint's keys can have their own URL.
      [scopeWith({ openai: WILDCARD }, ["openai"]), /not a custom OpenAI- or Anthropic-compatible endpoint/],
      // Inside the scope's providers when it lists some.
      [scopeWith({ [NODE_B]: WILDCARD }, [NODE]), /not one of scopes.providerKeys.providers/],
      // And an endpoint that exists.
      [scopeWith({ "openai-compatible-chat-gone": WILDCARD }, null), /Unknown provider/],
    ];
    for (const [scopes, why] of refused) {
      const res = await dashboard.create({ name: "hosts", scopes });
      expect(res.status, JSON.stringify(scopes)).toBe(400);
      expect(res.body.error, JSON.stringify(scopes)).toMatch(why);
    }
    expect((await dashboard.create({ name: "fifty", scopes: scopeWith({ [NODE]: Array.from({ length: 50 }, (_, i) => `key-${i}.acme.example`) }) })).status).toBe(201);

    // With no providers list, an endpoint named in baseUrlHosts is enough.
    const anyProvider = await newManagementKey(scopeWith({ [NODE]: WILDCARD }, null));
    expect((await db.getManagementKeyById(anyProvider.id)).scopes.providerKeys.baseUrlHosts).toEqual({ [NODE]: WILDCARD });

    // Trimmed and de-duplicated; an empty list is no hosts.
    const mk = await hostsKey({ [NODE]: [" *.acme.example ", "*.acme.example", "api.acme.example"], [NODE_B]: [] });
    expect((await db.getManagementKeyById(mk.id)).scopes.providerKeys.baseUrlHosts).toEqual({ [NODE]: ["*.acme.example", "api.acme.example"] });
    const none = await hostsKey({});
    expect((await db.getManagementKeyById(none.id)).scopes.providerKeys.baseUrlHosts).toBeNull();

    // A stored pattern that no longer validates grants nothing, like any broken scope.
    const adapter = await getAdapter();
    adapter.run("UPDATE managementKeys SET scopes = ? WHERE id = ?", [JSON.stringify(scopeWith({ [NODE]: ["*"] })), mk.id]);
    expect((await api.me(mk.secret)).body.managementKey.scopes.providerKeys).toMatchObject({ enabled: false, baseUrlHosts: null });
  });

  it("refuses an endpoint listed twice in different case, and more endpoints than the cap", async () => {
    const twice = await dashboard.create({ name: "twice", scopes: scopeWith({ [NODE]: WILDCARD, [NODE.replace("acme", "ACME")]: ["api.acme.example"] }) });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/is listed twice/);

    const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`openai-compatible-chat-n${i}`, WILDCARD]));
    expect(normalizeManagementScopes(scopeWith(many(200), null)).errors).toEqual([]);
    expect(normalizeManagementScopes(scopeWith(many(201), null)).errors.join("; ")).toMatch(/at most 200 endpoints/);
  });

  it("the dialog drops hosts for endpoints taken out of the scope or deleted, and only once the endpoints have loaded", () => {
    const pk = { enabled: true, providers: [NODE, NODE_B], manageExisting: false, baseUrlHosts: { [NODE]: WILDCARD, [NODE_B]: ["key-b.acme.example"], [ANODE]: [] } };
    // Taking NODE_B out of the scope drops its hosts in view.
    expect(scopeForm.withProviders(pk, [NODE]).baseUrlHosts).toEqual({ [NODE]: WILDCARD });
    // Clearing the list (any provider) keeps them.
    expect(scopeForm.withProviders(pk, []).baseUrlHosts).toEqual(pk.baseUrlHosts);
    // On save: only lists with hosts, for endpoints in the scope.
    expect(scopeForm.ownUrlHostsPayload({ ...pk, providers: [NODE] })).toEqual({ [NODE]: WILDCARD });
    expect(scopeForm.ownUrlHostsPayload(pk)).toEqual({ [NODE]: WILDCARD, [NODE_B]: ["key-b.acme.example"] });
    // A deleted endpoint's hosts are dropped, so the save goes through; not before the endpoints load.
    const anyProvider = { ...pk, providers: [] };
    expect(scopeForm.ownUrlHostsPayload(anyProvider, new Set([NODE]))).toEqual({ [NODE]: WILDCARD });
    expect(scopeForm.ownUrlHostsPayload(anyProvider, null)).toEqual({ [NODE]: WILDCARD, [NODE_B]: ["key-b.acme.example"] });
    expect(scopeForm.isDeletedEndpoint(NODE_B, new Set([NODE]))).toBe(true);
    expect(scopeForm.isDeletedEndpoint(NODE_B, null)).toBe(false);
    expect(scopeForm.ownUrlHostsPayload({ ...pk, baseUrlHosts: {} })).toBeNull();

    // Ids compare without case, as the server's checks do, so an unrelated edit keeps them.
    const mixed = { ...pk, providers: [NODE], baseUrlHosts: { [NODE.replace("acme", "ACME")]: WILDCARD } };
    expect(scopeForm.ownUrlHostsPayload(mixed, new Set([NODE]))).toEqual(mixed.baseUrlHosts);
    expect(scopeForm.withProviders(mixed, [NODE]).baseUrlHosts).toEqual(mixed.baseUrlHosts);
    expect(scopeForm.isDeletedEndpoint(NODE.toUpperCase(), new Set([NODE]))).toBe(false);
  });

  it("saving a key whose endpoint was deleted works once the dialog drops that endpoint's hosts", async () => {
    const gone = "openai-compatible-chat-acme-gone";
    await db.createProviderNode({ id: gone, type: "openai-compatible", name: "Gone", prefix: "gone", apiType: "chat", baseUrl: "https://gone.acme.example/v1" });
    const mk = await newManagementKey(scopeWith({ [NODE]: WILDCARD, [gone]: WILDCARD }, null));
    await db.deleteProviderNode(gone);
    const state = scopeForm.fromSaved((await db.getManagementKeyById(mk.id)).scopes);
    // The server stays strict about an unknown endpoint...
    expect((await dashboard.patch(mk.id, { name: "renamed", scopes: scopeForm.toPayload(state, null) })).status).toBe(400);
    // ...and the dialog, with the endpoints loaded, no longer sends it.
    const known = new Set((await db.getProviderNodes()).map((n) => n.id));
    const res = await dashboard.patch(mk.id, { name: "renamed", scopes: scopeForm.toPayload(state, known) });
    expect(res.status, res.text).toBe(200);
    expect((await db.getManagementKeyById(mk.id)).scopes.providerKeys.baseUrlHosts).toEqual({ [NODE]: WILDCARD });
  });

  it("a deleted endpoint in the scope's providers is dropped on save too, but never the last one", async () => {
    const gone = "openai-compatible-chat-acme-gone-2";
    await db.createProviderNode({ id: gone, type: "openai-compatible", name: "Gone 2", prefix: "gone2", apiType: "chat", baseUrl: "https://gone2.acme.example/v1" });
    const mk = await newManagementKey(scopeWith({ [NODE]: WILDCARD, [gone]: WILDCARD }, [NODE, gone, "openai"]));
    const alone = await newManagementKey(scopeWith({ [gone]: WILDCARD }, [gone]));
    await db.deleteProviderNode(gone);
    const known = new Set((await db.getProviderNodes()).map((n) => n.id));

    const state = scopeForm.fromSaved((await db.getManagementKeyById(mk.id)).scopes);
    // Before the endpoints load nothing is dropped; built-in providers are never "deleted".
    expect(scopeForm.toPayload(state, null).providerKeys.providers).toEqual([NODE, gone, "openai"]);
    expect(scopeForm.isDeletedEndpoint("openai", known)).toBe(false);
    expect(scopeForm.scopeProblem(state, known)).toBeNull();
    const res = await dashboard.patch(mk.id, { name: "renamed 2", scopes: scopeForm.toPayload(state, known) });
    expect(res.status, res.text).toBe(200);
    expect((await db.getManagementKeyById(mk.id)).scopes.providerKeys).toMatchObject({ providers: [NODE, "openai"], baseUrlHosts: { [NODE]: WILDCARD } });

    // Dropping the only provider would turn "only this endpoint" into "any provider": refused instead.
    const lone = scopeForm.fromSaved((await db.getManagementKeyById(alone.id)).scopes);
    expect(scopeForm.scopeProblem(lone, known)).toMatch(/Pick a provider, or turn provider keys off/);
    expect(scopeForm.toPayload(lone, known).providerKeys.providers).toEqual([gone]);
    expect((await dashboard.patch(alone.id, { scopes: scopeForm.toPayload(lone, known) })).status).toBe(400);
    expect((await db.getManagementKeyById(alone.id)).scopes.providerKeys.providers).toEqual([gone]);
  });

  it("turning provider keys off saves even when every provider it named was deleted, and turning them back on doesn't widen", async () => {
    const gone = "openai-compatible-chat-acme-gone-3";
    await db.createProviderNode({ id: gone, type: "openai-compatible", name: "Gone 3", prefix: "gone3", apiType: "chat", baseUrl: "https://gone3.acme.example/v1" });
    const mk = await newManagementKey({ clientKeys: OPENAI_ONLY.clientKeys, ...scopeWith({ [gone]: WILDCARD }, [gone]) });
    await db.deleteProviderNode(gone);
    const known = new Set((await db.getProviderNodes()).map((n) => n.id));

    // Off: no problem to report, and the save goes through.
    const state = scopeForm.fromSaved((await db.getManagementKeyById(mk.id)).scopes);
    const off = { ...state, providerKeys: { ...state.providerKeys, enabled: false } };
    expect(scopeForm.scopeProblem(off, known)).toBeNull();
    const res = await dashboard.patch(mk.id, { name: "off", scopes: scopeForm.toPayload(off, known) });
    expect(res.status, res.text).toBe(200);
    const saved = (await db.getManagementKeyById(mk.id)).scopes.providerKeys;
    // The list is kept, so it never reads as "any provider"; the deleted endpoint's hosts are gone.
    expect(saved).toMatchObject({ enabled: false, providers: [gone], baseUrlHosts: null });
    expect((await api.listProvider(mk.secret)).status).toBe(403);

    // Back on: the dialog stops the save, and the server refuses the deleted endpoint.
    const on = scopeForm.fromSaved((await db.getManagementKeyById(mk.id)).scopes);
    const reenabled = { ...on, providerKeys: { ...on.providerKeys, enabled: true } };
    expect(scopeForm.scopeProblem(reenabled, known)).toMatch(/Pick a provider/);
    expect(scopeForm.toPayload(reenabled, known).providerKeys.providers).toEqual([gone]);
    expect((await dashboard.patch(mk.id, { scopes: scopeForm.toPayload(reenabled, known) })).status).toBe(400);
    expect((await db.getManagementKeyById(mk.id)).scopes.providerKeys.enabled).toBe(false);
  });

  it("a wildcard matches exactly one more real label", () => {
    expect(hostMatchesPattern("key-a.acme.example", "*.acme.example")).toBe(true);
    expect(hostMatchesPattern("acme.example", "*.acme.example")).toBe(false);
    expect(hostMatchesPattern("a.b.acme.example", "*.acme.example")).toBe(false);
    expect(hostMatchesPattern("key-a.notacme.example", "*.acme.example")).toBe(false);
    expect(hostMatchesPattern("key-a.acme.example.", "*.acme.example")).toBe(false);
    expect(hostMatchesPattern("*.acme.example", "*.acme.example")).toBe(false);
    expect(hostMatchesPattern("-.acme.example", "*.acme.example")).toBe(false);
    expect(hostMatchesPattern("key_a.acme.example", "*.acme.example")).toBe(false);
    expect(hostMatchesPattern("api.acme.example", "api.acme.example")).toBe(true);
    expect(hostMatchesPattern("key-a.api.acme.example", "api.acme.example")).toBe(false);
  });

  it("adds a key with its own URL on an allowed host, stored where the dashboard keeps a key's URL", async () => {
    const mk = await hostsKey();
    const apiKey = providerSecret("own-url");
    const res = await api.createProvider(mk.secret, {
      provider: NODE, apiKey, name: "key-a", baseUrl: "https://key-a.acme.example/api/v2/v1/chat/completions",
    });
    expect(res.status, res.text).toBe(201);
    // Probed at its own URL, through the dashboard's validator.
    expect(validation.calls).toEqual([expect.objectContaining({ provider: NODE, apiKey, baseUrl: "https://key-a.acme.example/api/v2/v1" })]);
    const conn = await db.getProviderConnectionById(res.body.providerKey.id);
    expect(conn.providerSpecificData).toMatchObject({ baseUrl: "https://key-a.acme.example/api/v2/v1", ownBaseUrl: true, prefix: "acme" });
    expect(await db.getRowOwner("providerKey", conn.id)).toBe(mk.id);
    // The response still carries no providerSpecificData.
    expect(res.body.providerKey.providerSpecificData).toBeUndefined();
    expect(res.text).not.toContain("/api/v2");

    // An exact pattern works too, and a fragment is dropped (routing appends its path).
    const exact = await hostsKey({ [NODE]: ["key-b.acme.example"] });
    const frag = await api.createProvider(exact.secret, { provider: NODE, apiKey: providerSecret("exact"), name: "key-b", baseUrl: "https://key-b.acme.example/v1?x=1#frag" });
    expect(frag.status).toBe(201);
    expect((await db.getProviderConnectionById(frag.body.providerKey.id)).providerSpecificData.baseUrl).toBe("https://key-b.acme.example/v1?x=1");

    // The key's default model goes to the probe, which uses it when it has to name a model.
    validation.calls = [];
    expect((await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("dm"), name: "dm", defaultModel: "acme-opus", baseUrl: "https://key-e.acme.example/v1" })).status).toBe(201);
    expect(validation.calls).toEqual([expect.objectContaining({ defaultModel: "acme-opus", baseUrl: "https://key-e.acme.example/v1" })]);

    // null is no baseUrl: the key uses the endpoint's URL.
    const plain = await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("null-url"), name: "null url", baseUrl: null });
    expect(plain.status).toBe(201);
    const plainConn = await db.getProviderConnectionById(plain.body.providerKey.id);
    expect(plainConn.providerSpecificData.baseUrl).toBe(NODE_URL);
    expect(plainConn.providerSpecificData.ownBaseUrl).toBeUndefined();
  });

  it("refuses a baseUrl outside the scope with a 403, and a malformed one with a 400, adding nothing", async () => {
    // NODE has hosts; NODE_B and ANODE are in the scope with none.
    const mk = await hostsKey();
    const openaiToo = await hostsKey({ [NODE]: WILDCARD }, { providers: [NODE, "openai"] });
    const before = (await db.getProviderConnections()).length;
    const planted = `tok-${crypto.randomBytes(6).toString("hex")}`;
    const outside = [
      ["no hosts for this endpoint", mk.secret, NODE_B, "https://key-a.acme.example/v1", /hasn't allowed it any hosts for "openai-compatible-chat-acme-b"/],
      ["no hosts for an anthropic endpoint either", mk.secret, ANODE, "https://key-a.acme.example/v1", /hasn't allowed it any hosts/],
      ["a provider with no per-key URL", openaiToo.secret, "openai", "https://key-a.acme.example/v1", /hasn't allowed it any hosts for "openai"/],
      ["wrong host", mk.secret, NODE, "https://key-a.other.example/v1", /isn't one this management key may use/],
      ["the apex", mk.secret, NODE, "https://acme.example/v1", /isn't one this management key may use/],
      ["two labels deep", mk.secret, NODE, "https://a.b.acme.example/v1", /isn't one this management key may use/],
    ];
    const malformed = [
      ["http", "http://key-a.acme.example/v1", /must use https/],
      ["IPv4", "https://10.0.0.1/v1", /IP address/],
      ["IPv4 in another notation", "https://0x7f.1/v1", /IP address/],
      ["IPv6", "https://[::1]/v1", /IP address/],
      ["localhost", "https://localhost/v1", /localhost/],
      ["a .localhost name", "https://key-a.localhost/v1", /localhost/],
      ["port", "https://key-a.acme.example:8443/v1", /port other than 443/],
      ["user and password", `https://user:${planted}@key-a.acme.example/v1`, /user name or password/],
      ["a user name alone", `https://${planted}@key-a.acme.example/v1`, /user name or password/],
      ["not a URL", "key-a.acme.example/v1", /isn't a valid URL/],
      ["not a string", 42, /must be a URL/],
      ["over 2048 characters", `https://key-a.acme.example/${"a".repeat(2048)}`, /at most 2048 characters/],
    ];
    const cases = [
      ...outside.map(([label, secret, provider, baseUrl, why]) => ({ label, secret, provider, baseUrl, why, status: 403 })),
      ...malformed.map(([label, baseUrl, why]) => ({ label, secret: mk.secret, provider: NODE, baseUrl, why, status: 400 })),
    ];
    for (const { label, secret, provider, baseUrl, why, status } of cases) {
      const res = await api.createProvider(secret, { provider, apiKey: providerSecret(`url-${label}`), baseUrl });
      expect(res.status, label).toBe(status);
      expect(res.body.error, label).toMatch(why);
      expect(res.body.field, label).toBe("baseUrl");
      expect(res.text, label).not.toContain(planted);
    }
    expect(validation.calls).toHaveLength(0);
    expect((await db.getProviderConnections()).length).toBe(before);
    // Refusals about the scope are audited; ones about the URL's shape aren't.
    expect((await deniedRows(mk.id)).length).toBe(outside.filter(([, s]) => s === mk.secret).length);

    // A default :443 is no port. And the other URL and proxy fields stay closed, hosts or not.
    expect((await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("p443"), baseUrl: "https://key-c.acme.example:443/v1" })).status).toBe(201);
    for (const body of [
      { provider: NODE, apiKey: providerSecret("psd-url"), providerSpecificData: { baseUrl: "https://key-a.acme.example/v1" } },
      { provider: NODE, apiKey: providerSecret("psd-own"), providerSpecificData: { ownBaseUrl: true } },
      { provider: NODE, apiKey: providerSecret("proxy"), connectionProxyUrl: "https://key-a.acme.example" },
      { provider: NODE, apiKey: providerSecret("azure"), providerSpecificData: { azureEndpoint: "https://key-a.acme.example" } },
    ]) {
      expect((await api.createProvider(mk.secret, body)).status, JSON.stringify(Object.keys(body))).toBe(400);
    }
  });

  it("a host allowed for one endpoint can't point another endpoint's key at it", async () => {
    const mk = await hostsKey({ [NODE]: ["key-a.acme.example"], [NODE_B]: ["key-b.acme.example"] });
    const before = (await db.getProviderConnections()).length;
    const cross = await api.createProvider(mk.secret, { provider: NODE_B, apiKey: providerSecret("cross"), baseUrl: "https://key-a.acme.example/v1" });
    expect(cross.status).toBe(403);
    expect(cross.body.error).toMatch(/isn't one this management key may use \(key-b\.acme\.example\)/);
    expect((await db.getProviderConnections()).length).toBe(before);
    expect((await api.createProvider(mk.secret, { provider: NODE_B, apiKey: providerSecret("own-b"), name: "own b", baseUrl: "https://key-b.acme.example/v1" })).status).toBe(201);
  });

  it("still runs the private-network check: an allowed host that resolves to a private address adds nothing", async () => {
    dnsSpy.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const mk = await hostsKey();
    const before = (await db.getProviderConnections()).length;
    const res = await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("private"), baseUrl: "https://key-a.acme.example/v1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/URL not allowed/);
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("re-checks the host after the probe: hosts taken away meanwhile add nothing, and the refusal is audited", async () => {
    const mk = await hostsKey();
    const before = (await db.getProviderConnections()).length;
    for (const [label, narrowed, why, host] of [
      ["another host", { [NODE]: ["api.acme.example"] }, /isn't one this management key may use/, "key-a.acme.example"],
      ["every host", null, /hasn't allowed it any hosts/, undefined],
    ]) {
      validation.handler = async () => {
        await dashboard.patch(mk.id, { scopes: { providerKeys: { enabled: true, providers: [NODE], baseUrlHosts: narrowed } } });
        return Response.json({ valid: true });
      };
      const res = await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret(`narrowed-${label}`), baseUrl: "https://key-a.acme.example/v1" });
      expect(res.status, label).toBe(403);
      expect(res.body.error, label).toMatch(why);
      const [row] = await deniedRows(mk.id);
      expect(row.detail.reason, label).toMatch(/scope narrowed during validation/);
      expect(row.detail.baseUrlHost, label).toBe(host);
      await dashboard.patch(mk.id, { scopes: { providerKeys: { enabled: true, providers: [NODE, NODE_B, ANODE], baseUrlHosts: { [NODE]: WILDCARD } } } });
    }
    expect((await db.getProviderConnections()).length).toBe(before);
  });

  it("a management key can't set host patterns through the API, its own or another's", async () => {
    const mk = await hostsKey({ [NODE]: ["key-a.acme.example"] });
    const other = await newManagementKey({ providerKeys: { enabled: true, providers: [NODE] } });
    const widen = { providerKeys: { enabled: true, baseUrlHosts: { [NODE]: WILDCARD, [NODE_B]: WILDCARD }, manageExisting: true } };
    // No route on the management API takes scopes.
    expect((await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("scopes"), scopes: widen })).status).toBe(400);
    expect((await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("hosts"), baseUrlHosts: { [NODE]: WILDCARD } })).status).toBe(400);
    // The dashboard routes take a session, never a management key.
    const bearer = { authorization: `Bearer ${mk.secret}` };
    for (const id of [mk.id, other.id]) {
      expect((await dashboard.patch(id, { scopes: widen }, bearer)).status).toBe(401);
    }
    expect((await dashboard.create({ name: "self-made", scopes: widen }, bearer)).status).toBe(401);
    expect((await db.getManagementKeyById(mk.id)).scopes.providerKeys).toMatchObject({ baseUrlHosts: { [NODE]: ["key-a.acme.example"] }, manageExisting: false });
    expect((await db.getManagementKeyById(other.id)).scopes.providerKeys.baseUrlHosts).toBeNull();
  });

  it("routes a key added this way to its own URL, and others to the endpoint's", async () => {
    const mk = await hostsKey({ [NODE]: WILDCARD, [ANODE]: WILDCARD });
    const a = await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("route-a"), name: "route a", baseUrl: "https://key-a.acme.example/api/v2/v1" });
    const b = await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("route-b"), name: "route b", baseUrl: "https://key-b.acme.example/api/v2/v1" });
    const plain = await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("route-plain"), name: "route plain" });
    const anth = await api.createProvider(mk.secret, { provider: ANODE, apiKey: providerSecret("route-anth"), name: "route anth", baseUrl: "https://key-c.acme.example/anthropic/v1" });
    expect([a.status, b.status, plain.status, anth.status]).toEqual([201, 201, 201, 201]);

    const hits = [];
    upstream.handler = async (url) => {
      hits.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const send = async (provider, created, body) => {
      // The credentials the account loop hands the executor for this key.
      const credentials = await getProviderCredentials(provider, null, null, { preferredConnectionId: created.body.providerKey.id });
      expect(credentials.connectionId).toBe(created.body.providerKey.id);
      const out = await getExecutor(provider).execute({ model: "m", body, stream: false, credentials, log: null });
      expect(out.response.status).toBe(200);
    };
    for (const created of [a, b, plain]) await send(NODE, created, { model: "m", messages: [{ role: "user", content: "hi" }] });
    await send(ANODE, anth, { model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    expect(hits).toEqual([
      "https://key-a.acme.example/api/v2/v1/chat/completions",
      "https://key-b.acme.example/api/v2/v1/chat/completions",
      `${NODE_URL}/chat/completions`,
      "https://key-c.acme.example/anthropic/v1/messages",
    ]);
  });

  it("the audit records the host it was given, never the full URL", async () => {
    const mk = await hostsKey();
    const planted = `tok-${crypto.randomBytes(6).toString("hex")}`;
    const ok = await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("audit-url"), name: "audit url", baseUrl: `https://key-a.acme.example/secret-path/v1?token=${planted}` });
    expect(ok.status).toBe(201);
    await api.createProvider(mk.secret, { provider: NODE, apiKey: providerSecret("audit-wrong"), baseUrl: `https://key-z.other.example/secret-path?token=${planted}` });
    await api.createProvider(mk.secret, { provider: NODE_B, apiKey: providerSecret("audit-none"), baseUrl: `https://key-a.acme.example/secret-path?token=${planted}` });
    const rows = await db.getManagementAudit({ managementKeyId: mk.id, limit: 10 });
    expect(rows.find((r) => r.action === "provider_key.create").detail).toEqual({ provider: NODE, name: "audit url", baseUrlHost: "key-a.acme.example" });
    const denied = rows.filter((r) => r.action === "provider_key.create.denied").map((r) => r.detail);
    expect(denied).toEqual([
      { provider: NODE_B, reason: "no baseUrl hosts allowed for this provider" },
      { provider: NODE, baseUrlHost: "key-z.other.example", reason: "baseUrl host outside scope" },
    ]);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(planted);
    expect(raw).not.toContain("secret-path");
    expect(raw).not.toContain("https://");
  });

  it("describes the hosts in the scope summary", async () => {
    const { describeScopes } = await import("@/shared/utils/managementKey.js");
    expect(describeScopes({ providerKeys: { enabled: true, providers: [NODE], baseUrlHosts: { [NODE]: WILDCARD } } }))
      .toBe(`Provider keys (${NODE}), own URLs: ${NODE} on *.acme.example`);
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

  it("deletes of rows a key didn't create are kept apart, so its own create-and-delete loops and renames can't trim them", async () => {
    const { AUDIT_KEEP_DELETES_PER_KEY, AUDIT_KEEP_PER_KEY } = await import("@/lib/db/repos/managementKeysRepo.js");
    const wide = await newManagementKey({
      clientKeys: { enabled: true, manageExisting: true },
      providerKeys: { enabled: true, providers: ["openai"], manageExisting: true },
    });
    const adminProvider = (await db.createProviderConnection({ provider: "openai", authType: "apikey", name: "admin pool row", apiKey: providerSecret("admin-row") })).id;
    const adminClient = (await dashboardClientKey("admin client row")).id;
    expect((await api.deleteProvider(wide.secret, adminProvider)).status).toBe(200);
    expect((await api.deleteClient(wide.secret, adminClient)).status).toBe(200);
    const adapter = await getAdapter();
    const poolOf = (action, targetId) => adapter.get("SELECT pool FROM managementAudit WHERE managementKeyId = ? AND action = ? AND targetId = ?", [wide.id, action, targetId])?.pool;
    expect(poolOf("provider_key.delete", adminProvider)).toBe("delete");
    expect(poolOf("client_key.delete", adminClient)).toBe("delete");

    // Its own rows: deletes stay with its other actions.
    const ownProvider = (await api.createProvider(wide.secret, { provider: "openai", apiKey: providerSecret("own-row"), name: "own pool row" })).body.providerKey.id;
    expect((await api.deleteProvider(wide.secret, ownProvider)).status).toBe(200);
    expect(poolOf("provider_key.delete", ownProvider)).toBe("ok");

    for (let i = 0; i < AUDIT_KEEP_DELETES_PER_KEY + 1; i++) {
      const id = (await api.createClient(wide.secret, { name: `loop ${i}` })).body.clientKey.id;
      expect((await api.deleteClient(wide.secret, id)).status).toBe(200);
    }
    expect(poolOf("provider_key.delete", adminProvider)).toBe("delete");
    expect(poolOf("client_key.delete", adminClient)).toBe("delete");
    expect(adapter.get("SELECT COUNT(*) AS n FROM managementAudit WHERE managementKeyId = ? AND pool = 'ok'", [wide.id]).n).toBe(AUDIT_KEEP_PER_KEY);
  }, 120_000);

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

describe("round 4: rechecks inside the write", () => {
  it("an edit is refused with 401 when the key is paused or expired between the read and the write", async () => {
    for (const change of [{ isActive: false }, { expiresAt: new Date(Date.now() - 1000).toISOString() }]) {
      const mk = await newManagementKey(OPENAI_ONLY);
      const id = (await api.createClient(mk.secret, { name: "edit race", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
      dbHooks.beforeUpdateAs = () => db.updateManagementKey(mk.id, change);
      expect((await api.patchClient(mk.secret, id, { budgetUsd: 2 })).status, JSON.stringify(change)).toBe(401);
      expect((await db.getApiKeyById(id)).budgetUsd).toBe(1);
      dbHooks.beforeUpdateAs = null;
    }
  });

  it("a client-key delete is refused when the key is paused, or the row stops being its own, between the read and the delete", async () => {
    const paused = await newManagementKey(OPENAI_ONLY);
    const a = (await api.createClient(paused.secret, { name: "delete race 1", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    dbHooks.beforeDeleteAs = () => db.updateManagementKey(paused.id, { isActive: false });
    expect((await api.deleteClient(paused.secret, a)).status).toBe(401);
    expect(await db.getApiKeyById(a)).not.toBeNull();

    const owner = await newManagementKey(OPENAI_ONLY);
    const b = (await api.createClient(owner.secret, { name: "delete race 2", allowedModels: ["openai/gpt-5"], budgetUsd: 1 })).body.clientKey.id;
    dbHooks.beforeDeleteAs = () => db.setRowOwner("clientKey", b, null);
    expect((await api.deleteClient(owner.secret, b)).status).toBe(404);
    expect(await db.getApiKeyById(b)).not.toBeNull();
  });

  it("a provider-key delete is refused when the key is paused, or an admin takes the row over, between the read and the delete", async () => {
    const scope = { providerKeys: { enabled: true, providers: ["openai"] } };
    const paused = await newManagementKey(scope);
    const a = (await api.createProvider(paused.secret, { provider: "openai", apiKey: providerSecret("del-race-1"), name: "del race 1" })).body.providerKey.id;
    dbHooks.beforeDeleteAs = () => db.updateManagementKey(paused.id, { isActive: false });
    expect((await api.deleteProvider(paused.secret, a)).status).toBe(401);
    expect(await db.getProviderConnectionById(a)).not.toBeNull();

    const owner = await newManagementKey(scope);
    const b = (await api.createProvider(owner.secret, { provider: "openai", apiKey: providerSecret("del-race-2"), name: "del race 2" })).body.providerKey.id;
    dbHooks.beforeDeleteAs = () => db.updateProviderConnection(b, { apiKey: providerSecret("admin-takeover") });
    expect((await api.deleteProvider(owner.secret, b)).status).toBe(404);
    expect(await db.getProviderConnectionById(b)).not.toBeNull();
  });
});

describe("round 4: restoring a backup from before management keys", () => {
  it("leaves every row with no owner and no actor, and off or expiring keys count as the dashboard's", async () => {
    const admin = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true }, providerKeys: { enabled: true, manageExisting: true } });
    const legacy = {
      apiKeys: [
        { id: "old-off", key: "sk-old-off-0001", name: "old off", machineId: "m", isActive: false, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "old-exp", key: "sk-old-exp-0001", name: "old expiring", machineId: "m", isActive: true, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2027-06-01T00:00:00.000Z" },
      ],
      providerConnections: [
        { id: "old-conn", provider: "openai", authType: "apikey", name: "old pool", apiKey: providerSecret("old-conn"), isActive: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      ],
    };
    await db.importDb(legacy);
    for (const id of ["old-off", "old-exp"]) {
      expect(await db.getApiKeyById(id)).toMatchObject({ ownerManagementKeyId: null, disabledBy: null, expiresAtSetBy: null });
    }
    expect(await db.getRowOwner("providerKey", "old-conn")).toBeNull();
    expect((await api.patchClient(admin.secret, "old-off", { isActive: true })).status).toBe(403);
    expect((await api.patchClient(admin.secret, "old-exp", { expiresAt: null })).status).toBe(403);
    expect((await api.patchClient(admin.secret, "old-exp", { expiresAt: "2028-01-01T00:00:00.000Z" })).status).toBe(403);
  });
});

describe("no secrets in any response", () => {
  it("no response carries a provider secret, a full client key outside its create response, or a management secret outside its own", async () => {
    // Make sure at least one listing of everything runs last.
    const admin = await newManagementKey({ clientKeys: { enabled: true, manageExisting: true }, providerKeys: { enabled: true, manageExisting: true } });
    await api.listClient(admin.secret);
    await api.listProvider(admin.secret);

    // Every client key ever issued, including ones deleted since.
    const clientKeySet = new Set([
      ...(await db.getApiKeys()).map((k) => k.key),
      ...seen.filter((s) => s.label === "POST /api/management/v1/client-keys" && s.status === 201).map((s) => JSON.parse(s.text).key),
    ]);
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
      const fullKeys = [...new Set(text.match(/sk-[A-Za-z0-9_-]+/g) || [])].filter((t) => clientKeySet.has(t));
      if (isClientCreate) expect(fullKeys, label).toEqual([JSON.parse(text).key]);
      else expect(fullKeys, label).toEqual([]);

      const isDashboardCreate = label === "POST /api/management-keys" && status === 201;
      const secrets = text.match(/10r-mgmt-[A-Za-z0-9_-]{20,}/g) || [];
      if (isDashboardCreate) expect(secrets, label).toEqual([JSON.parse(text).secret]);
      else expect(secrets, label).toEqual([]);
    }
  }, 120_000);
});
