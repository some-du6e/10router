// Routing guards on the real chat handler against a throwaway database; only
// account selection and chatCore are stubbed. Covers combos that contain
// themselves, a key revoked while its request is held through a rate limit,
// and an allowlist naming a combo whose name differs from another's only by case.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-routing-guards-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const upstream = { credentials: vi.fn(), core: vi.fn(), comboLookups: 0 };

vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    getProviderCredentials: (...args) => upstream.credentials(...args),
    markAccountUnavailable: async () => ({ shouldFallback: false, cooldownMs: 0 }),
    clearAccountError: async () => {},
  };
});
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: (...args) => upstream.core(...args),
}));
// Counts lookups, and stops a runaway recursion so a regression fails instead of hanging.
vi.mock("@/sse/services/model.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getComboModels: async (name) => (++upstream.comboLookups > 500 ? null : actual.getComboModels(name)),
  };
});

const db = await import("@/lib/db/index.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const { handleChat } = await import("@/sse/handlers/chat.js");
const { DEFAULT_TIMING } = await import("open-sse/utils/limitHold.js");

async function newKey(name, limits = {}) {
  const created = await db.createApiKey(name, "machine-routing-0001");
  if (Object.keys(limits).length) await db.updateApiKey(created.id, limits);
  return db.getApiKeyById(created.id);
}

function chatRequest(key, model, body = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key.key}`;
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

const reached = () => upstream.core.mock.calls.map(([args]) => `${args.modelInfo.provider}/${args.modelInfo.model}`);

beforeAll(async () => {
  await getAdapter();
  await db.updateSettings({ requireApiKey: true });
  await db.createCombo({ name: "loopy", models: ["loopy", "openai/gpt-fallback"] });
  await db.createCombo({ name: "ping", models: ["pong", "openai/gpt-after-ping"] });
  await db.createCombo({ name: "pong", models: ["ping"] });
  await db.createCombo({ name: "team-a", models: ["openai/model-ok"] });
  await db.createCombo({ name: "Team-A", models: ["anthropic/model-denied"] });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  upstream.credentials.mockReset();
  upstream.core.mockReset();
  upstream.comboLookups = 0;
  upstream.credentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "acct", accessToken: "t" });
  upstream.core.mockImplementation(async () => ({ success: true, response: new Response(JSON.stringify({ ok: true }), { status: 200 }) }));
});

describe("a combo that contains itself", () => {
  it("skips the repeated combo and reaches the next member", async () => {
    const key = await newKey("self-cycle");
    const res = await handleChat(chatRequest(key, "loopy"));
    expect(res.status).toBe(200);
    expect(reached()).toEqual(["openai/gpt-fallback"]);
    expect(upstream.comboLookups).toBeLessThan(10);
  });

  it("stops a cycle through another combo too", async () => {
    const key = await newKey("mutual-cycle");
    const res = await handleChat(chatRequest(key, "ping"));
    expect(res.status).toBe(200);
    expect(reached()).toEqual(["openai/gpt-after-ping"]);
    expect(upstream.comboLookups).toBeLessThan(10);
  });
});

describe("a key revoked while its request is held", () => {
  async function held(revoke, body) {
    const timing = { ...DEFAULT_TIMING };
    Object.assign(DEFAULT_TIMING, { minWaitMs: 10, recheckMs: 10, keepaliveMs: 5 });
    await db.updateSettings({ limitHoldEnabled: true });
    try {
      const key = await newKey(`held-${revoke.name}-${body.stream}`);
      upstream.credentials.mockImplementationOnce(async () => {
        await revoke(key);
        return { allRateLimited: true, retryAfter: new Date(Date.now() + 20).toISOString(), retryAfterHuman: "reset after 1s", lastError: "rate limited", lastErrorCode: 429 };
      });
      const res = await handleChat(chatRequest(key, "openai/gpt-a", body));
      const text = await res.text();
      return { res, text };
    } finally {
      Object.assign(DEFAULT_TIMING, timing);
      await db.updateSettings({ limitHoldEnabled: false });
    }
  }
  const disable = (key) => db.updateApiKey(key.id, { isActive: false });
  const remove = (key) => db.deleteApiKey(key.id);

  it("refuses a held JSON request once the key is disabled", async () => {
    const { res } = await held(disable, { stream: false });
    expect(res.status).toBe(401);
    expect(upstream.core).not.toHaveBeenCalled();
  });

  it("refuses a held JSON request once the key is deleted", async () => {
    const { res } = await held(remove, { stream: false });
    expect(res.status).toBe(401);
    expect(upstream.core).not.toHaveBeenCalled();
  });

  it("ends a held stream without running it once the key is disabled", async () => {
    const { text } = await held(disable, { stream: true });
    expect(upstream.core).not.toHaveBeenCalled();
    expect(text).toContain("Invalid API key");
  });
});

describe("an allowlist naming a combo", () => {
  it("allows only the combo spelled that way, not one differing by case", async () => {
    const key = await newKey("case-combo", { allowedModels: ["team-a"] });
    expect((await handleChat(chatRequest(key, "team-a"))).status).toBe(200);
    expect(reached()).toEqual(["openai/model-ok"]);
    upstream.core.mockClear();
    expect((await handleChat(chatRequest(key, "Team-A"))).status).toBe(403);
    expect(upstream.core).not.toHaveBeenCalled();
  });

  it("still allows a differently-cased combo whose members are all allowed", async () => {
    const key = await newKey("case-members", { allowedModels: ["TEAM-A", "openai/model-ok"] });
    expect((await handleChat(chatRequest(key, "team-a"))).status).toBe(200);
  });
});
