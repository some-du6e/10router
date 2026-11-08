// Client API key limits: budget, model allowlist, expiry, spend reset, the
// running spend total, the self-service /v1/key endpoint and the keys API.
// Runs the real handlers against a throwaway database; only the upstream
// (credentials + chatCore) is stubbed, so "rejected before any upstream call"
// is observable as "credentials were never fetched".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-key-budgets-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const upstream = { credentials: vi.fn(), core: vi.fn(), adapterPool: [] };

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
// The capacity adapter's own model choice (which needs capability data) is
// replaced by a fixed pool; what chat.ts does with the pool is under test.
vi.mock("open-sse/services/capacityAdapter.js", async (importOriginal) => ({
  ...(await importOriginal()),
  augmentModelsWithCapacityAdapter: (models) => (upstream.adapterPool.length ? [...upstream.adapterPool, ...models] : models),
}));

const db = await import("@/lib/db/index.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const { saveRequestUsage, updateSettings, createApiKey, updateApiKey, getApiKeyById, createCombo, setModelAlias, updatePricing } = db;
const { handleChat } = await import("@/sse/handlers/chat.js");
const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
const { checkApiKeyLimits, filterModelsForRequest, isModelAllowed, keepAllowedAdapterModels } = await import("@/sse/services/keyLimits.js");
const { GET: getOwnKey } = await import("@/app/api/v1/key/route.js");
const { PUT: putKey } = await import("@/app/api/keys/[id]/route.js");
const { GET: getKeyUsage } = await import("@/app/api/keys/[id]/usage/route.js");
const { parseKeyLimitsInput, budgetState, pickInternalKey } = await import("@/shared/utils/apiKeyLimits.js");

const MACHINE = "machine-test-0001";
const PRICED = { provider: "testprov", model: "m1" };

async function newKey(name, limits = {}) {
  const created = await createApiKey(name, MACHINE);
  if (Object.keys(limits).length) await updateApiKey(created.id, limits);
  return getApiKeyById(created.id);
}

/** Spend `usd` on a key the way real traffic does: through saveRequestUsage. */
async function spend(key, usd) {
  // testprov/m1 costs $1 per 1M input tokens.
  await saveRequestUsage({ ...PRICED, apiKey: key.key, tokens: { prompt_tokens: Math.round(usd * 1_000_000), completion_tokens: 0 } });
}

function chatRequest(key, model, { endpoint = "/v1/chat/completions", body = {} } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key.key}`;
  const payload = endpoint === "/v1/messages"
    ? { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }], ...body }
    : { model, messages: [{ role: "user", content: "hi" }], ...body };
  return new Request(`http://localhost${endpoint}`, { method: "POST", headers, body: JSON.stringify(payload) });
}

const params = (id) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  await getAdapter();
  await updateSettings({ requireApiKey: true });
  await updatePricing({ [PRICED.provider]: { [PRICED.model]: { input: 1, output: 1 } } });
  await createCombo({ name: "safe-combo", models: ["openai/gpt-a", "anthropic/claude-x"] });
  await createCombo({ name: "mixed-combo", models: ["openai/gpt-a", "openai/gpt-forbidden"] });
  await setModelAlias("fast", "openai/gpt-a");
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
  upstream.adapterPool = [];
  upstream.credentials.mockResolvedValue({ connectionId: "conn-1", connectionName: "acct", accessToken: "t" });
  upstream.core.mockImplementation(async () => ({ success: true, response: new Response(JSON.stringify({ ok: true }), { status: 200 }) }));
});

describe("a key with no limits", () => {
  it("behaves exactly as before: the request reaches the upstream", async () => {
    const key = await newKey("plain");
    expect(key).toMatchObject({ budgetUsd: null, allowedModels: null, expiresAt: null, spentUsd: 0 });
    const res = await handleChat(chatRequest(key, "openai/gpt-a"));
    expect(res.status).toBe(200);
    expect(upstream.core).toHaveBeenCalledTimes(1);
  });

  it("still reaches the upstream after spending, with no budget to hit", async () => {
    const key = await newKey("plain-spender");
    await spend(key, 50);
    expect(await checkApiKeyLimits(key.key, { model: "anything/at-all" })).toBeNull();
    expect((await handleChat(chatRequest(key, "openai/whatever"))).status).toBe(200);
  });

  it("leaves a request with no key to the existing API-key check", async () => {
    const res = await handleChat(chatRequest(null, "openai/gpt-a"));
    expect(res.status).toBe(401);
    expect(upstream.credentials).not.toHaveBeenCalled();
  });
});

describe("budget", () => {
  it("rejects an over-budget key before any upstream call, in OpenAI's error shape", async () => {
    const key = await newKey("over", { budgetUsd: 5 });
    await spend(key, 6);
    const res = await handleChat(chatRequest(key, "openai/gpt-a"));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.type).toBe("insufficient_quota");
    expect(body.error.code).toBe("key_budget_exceeded");
    expect(body.error.message).toMatch(/budget is used up/);
    expect(body.error.message).toContain("$6.00 of its $5.00");
    expect(upstream.credentials).not.toHaveBeenCalled();
    expect(upstream.core).not.toHaveBeenCalled();
  });

  it("answers the Messages API in Anthropic's error shape", async () => {
    const key = await newKey("over-claude", { budgetUsd: 1 });
    await spend(key, 2);
    const res = await handleChat(chatRequest(key, "anthropic/claude-x", { endpoint: "/v1/messages" }));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toMatchObject({ type: "error", error: { type: "billing_error" } });
    expect(body.error.message).toMatch(/budget is used up/);
    expect(upstream.credentials).not.toHaveBeenCalled();
  });

  it("refuses at exactly the budget and allows just under it", async () => {
    const key = await newKey("boundary", { budgetUsd: 3 });
    await spend(key, 2.99);
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(200);
    await spend(key, 0.01);
    expect((await getApiKeyById(key.id)).spentUsd).toBeCloseTo(3, 6);
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(402);
  });

  it("a $0 budget lets nothing through", async () => {
    const key = await newKey("zero", { budgetUsd: 0 });
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(402);
    expect(budgetState({ budgetUsd: 0, spentUsd: 0 }).exhausted).toBe(true);
    expect(budgetState({ budgetUsd: 10, spentUsd: 9.99 }).exhausted).toBe(false);
    expect(budgetState({ budgetUsd: 10, spentUsd: 10 }).exhausted).toBe(true);
  });

  it("raising the budget tops the key up", async () => {
    const key = await newKey("topup", { budgetUsd: 1 });
    await spend(key, 1.5);
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(402);
    await updateApiKey(key.id, { budgetUsd: 2 });
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(200);
  });

  it("covers non-chat endpoints too (embeddings)", async () => {
    const key = await newKey("embed-over", { budgetUsd: 1 });
    await spend(key, 1);
    const req = new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hi" }),
    });
    const res = await handleEmbeddings(req);
    expect(res.status).toBe(402);
    expect(upstream.credentials).not.toHaveBeenCalled();
  });

  const json = (key, url, body) => new Request(`http://localhost${url}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` }, body: JSON.stringify(body),
  });
  it.each([
    ["images", async () => (await import("@/sse/handlers/imageGeneration.js")).handleImageGeneration, (k) => json(k, "/v1/images/generations", { model: "openai/img", prompt: "a cat" })],
    ["speech", async () => (await import("@/sse/handlers/tts.js")).handleTts, (k) => json(k, "/v1/audio/speech", { model: "openai/tts-1", input: "hi" })],
    ["transcriptions", async () => (await import("@/sse/handlers/stt.js")).handleStt, (k) => {
      const form = new FormData();
      form.set("model", "openai/whisper-1");
      form.set("file", new Blob([new Uint8Array([1, 2, 3])]), "a.wav");
      return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${k.key}` }, body: form });
    }],
    ["web search", async () => (await import("@/sse/handlers/search.js")).handleSearch, (k) => json(k, "/v1/search", { model: "tavily", query: "news" })],
    ["web fetch", async () => (await import("@/sse/handlers/fetch.js")).handleFetch, (k) => json(k, "/v1/web/fetch", { model: "jina", url: "https://example.com" })],
    ["systemone", async () => (await import("@/sse/handlers/systemone.js")).handleSystemone, (k) => json(k, "/v1/systemone", { model: "openai/gpt-a", state: {}, questions: { q: "?" } })],
    ["video", async () => (await import("@/sse/handlers/videoGeneration.js")).handleVideoCreate, (k) => json(k, "/v1/videos/generations", { model: "xai/video", prompt: "waves" })],
  ])("covers %s: an over-budget key never reaches the upstream", async (_name, load, makeRequest) => {
    const handler = await load();
    const key = await newKey("other-endpoints", { budgetUsd: 1 });
    await spend(key, 1);
    const res = await handler(makeRequest(key), "generations");
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("key_budget_exceeded");
    expect(upstream.credentials).not.toHaveBeenCalled();
  });
});

describe("spend reset", () => {
  it("starts the key at $0 against its budget and keeps the history", async () => {
    const key = await newKey("reset", { budgetUsd: 4 });
    await spend(key, 5);
    const adapter = await getAdapter();
    const rowsBefore = adapter.get("SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ?", [key.key]).c;
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(402);

    const reset = await updateApiKey(key.id, { resetSpend: true });
    expect(reset.spentUsd).toBe(0);
    expect(reset.lifetimeSpentUsd).toBeCloseTo(5, 6);
    expect(reset.spendResetAt).toBeTruthy();
    expect(adapter.get("SELECT COUNT(*) AS c FROM usageHistory WHERE apiKey = ?", [key.key]).c).toBe(rowsBefore);
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(200);

    // Spend after the reset counts against the budget again.
    await spend(key, 4);
    const after = await getApiKeyById(key.id);
    expect(after.spentUsd).toBeCloseTo(4, 6);
    expect(after.lifetimeSpentUsd).toBeCloseTo(9, 6);
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(402);
  });
});

describe("running total", () => {
  it("matches SUM(usageHistory.cost) for the key after many writes", async () => {
    const key = await newKey("tally");
    const other = await newKey("tally-other");
    for (let i = 1; i <= 25; i++) {
      await spend(key, i * 0.0137);
      if (i % 5 === 0) await spend(other, 0.5);
    }
    // A row with no cost still counts as a request.
    await saveRequestUsage({ provider: "unpriced", model: "free", apiKey: key.key, tokens: { prompt_tokens: 10, completion_tokens: 1 } });

    const adapter = await getAdapter();
    const sum = adapter.get("SELECT SUM(cost) AS s, COUNT(*) AS c, MAX(timestamp) AS t FROM usageHistory WHERE apiKey = ?", [key.key]);
    const stored = await getApiKeyById(key.id);
    expect(sum.s).toBeGreaterThan(4);
    expect(stored.spentUsd).toBeCloseTo(sum.s, 9);
    expect(stored.requestCount).toBe(sum.c);
    expect(stored.requestCount).toBe(26);
    expect(stored.lastUsedAt).toBe(sum.t);
    expect((await getApiKeyById(other.id)).spentUsd).toBeCloseTo(2.5, 9);
  });
});

describe("model allowlist", () => {
  it("allows a listed model and refuses others with a 403 before any upstream call", async () => {
    const key = await newKey("opus-only", { allowedModels: ["openai/gpt-a"] });
    expect((await handleChat(chatRequest(key, "openai/gpt-a"))).status).toBe(200);
    upstream.credentials.mockClear();

    const res = await handleChat(chatRequest(key, "openai/gpt-forbidden"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatchObject({ type: "permission_error", code: "model_not_allowed" });
    expect(body.error.message).toContain("openai/gpt-forbidden");
    expect(upstream.credentials).not.toHaveBeenCalled();
  });

  it("allows an alias whose target is listed", async () => {
    const key = await newKey("alias-ok", { allowedModels: ["openai/gpt-a"] });
    expect((await handleChat(chatRequest(key, "fast"))).status).toBe(200);
  });

  it("allows a combo whose every member is allowed, refuses one with a member that isn't", async () => {
    const key = await newKey("combo-check", { allowedModels: ["openai/gpt-a", "anthropic/claude-x"] });
    expect((await handleChat(chatRequest(key, "safe-combo"))).status).toBe(200);
    expect((await handleChat(chatRequest(key, "mixed-combo"))).status).toBe(403);
  });

  it("allows a combo named on the list as a whole", async () => {
    const key = await newKey("combo-named", { allowedModels: ["mixed-combo"] });
    expect((await handleChat(chatRequest(key, "mixed-combo"))).status).toBe(200);
    expect((await handleChat(chatRequest(key, "openai/gpt-forbidden"))).status).toBe(403);
  });

  it("answers the Messages API in Anthropic's shape", async () => {
    const key = await newKey("allow-claude", { allowedModels: ["anthropic/claude-x"] });
    const res = await handleChat(chatRequest(key, "anthropic/claude-other", { endpoint: "/v1/messages" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "permission_error" } });
  });

  it("matching rules: bare id = any provider, prefixed = that provider, suffix and case ignored", async () => {
    const lookup = { aliases: { fast: "cc/claude-opus-5-5" }, comboModels: async (n) => (n === "c" ? ["cc/claude-opus-5-5"] : null) };
    expect(await isModelAllowed("cc/claude-opus-5-5", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("claude-opus-5-5[1m]", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("CC/Claude-Opus-5-5", ["cc/claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("other/claude-opus-5-5", ["cc/claude-opus-5-5"], lookup)).toBe(false);
    expect(await isModelAllowed("claude-sonnet-5-5", ["claude-opus-5-5"], lookup)).toBe(false);
    expect(await isModelAllowed("fast", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("c", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("anything", null, lookup)).toBe(true);
  });

  it("a provider alias counts as the provider (cc = claude)", async () => {
    expect(await isModelAllowed("claude/claude-opus-5-5", ["cc/claude-opus-5-5"], {})).toBe(true);
    expect(await isModelAllowed("cc/claude-opus-5-5", ["claude/claude-opus-5-5"], {})).toBe(true);
  });

  it("a bare-id match goes one level deep: cc/x on the list doesn't allow openrouter/cc/x", async () => {
    expect(await isModelAllowed("openrouter/cc/x", ["cc/x"], {})).toBe(false);
    expect(await isModelAllowed("openrouter/x", ["x"], {})).toBe(true);
    expect(await isModelAllowed("openrouter/cc/x", ["x"], {})).toBe(false);
    const key = await newKey("nested-prefix", { allowedModels: ["openai/gpt-a"] });
    expect((await handleChat(chatRequest(key, "openrouter/openai/gpt-a"))).status).toBe(403);
  });

  it("checks a fusion combo's judge along with its members", async () => {
    await createCombo({ name: "fusion-combo", models: ["openai/gpt-a", "anthropic/claude-x"] });
    await updateSettings({ comboStrategies: { "fusion-combo": { fallbackStrategy: "fusion", judgeModel: "openai/gpt-forbidden" } } });
    try {
      const key = await newKey("fusion-judge", { allowedModels: ["openai/gpt-a", "anthropic/claude-x"] });
      const res = await handleChat(chatRequest(key, "fusion-combo"));
      expect(res.status).toBe(403);
      expect(upstream.credentials).not.toHaveBeenCalled();
      const withJudge = await newKey("fusion-judge-ok", { allowedModels: ["openai/gpt-a", "anthropic/claude-x", "openai/gpt-forbidden"] });
      expect(await checkApiKeyLimits(withJudge.key, { model: "fusion-combo" })).toBeNull();
    } finally {
      await updateSettings({ comboStrategies: {} });
    }
  });

  it("the capacity adapter never routes an allowlisted key to a model off its list", async () => {
    upstream.adapterPool = ["openai/gpt-pool"];
    const limited = await newKey("adapter-limited", { allowedModels: ["openai/gpt-a"] });
    expect((await handleChat(chatRequest(limited, "openai/gpt-a"))).status).toBe(200);
    expect(upstream.core.mock.calls.map(([args]) => args.modelInfo.model)).not.toContain("gpt-pool");

    upstream.core.mockClear();
    const plain = await newKey("adapter-plain");
    await handleChat(chatRequest(plain, "openai/gpt-a"));
    expect(upstream.core.mock.calls[0][0].modelInfo.model).toBe("gpt-pool");

    expect(await keepAllowedAdapterModels(limited.key, ["openai/gpt-pool", "openai/gpt-a"], ["openai/gpt-a"])).toEqual(["openai/gpt-a"]);
    expect(await keepAllowedAdapterModels(plain.key, ["openai/gpt-pool", "openai/gpt-a"], ["openai/gpt-a"])).toEqual(["openai/gpt-pool", "openai/gpt-a"]);
  });

  it("filters the adapter's models on a combo, and on a combo inside a combo", async () => {
    await createCombo({ name: "outer-combo", models: ["safe-combo"] });
    upstream.adapterPool = ["openai/gpt-pool"];
    const routed = () => upstream.core.mock.calls.map(([args]) => args.modelInfo.model);

    const comboKey = await newKey("adapter-combo", { allowedModels: ["safe-combo"] });
    expect((await handleChat(chatRequest(comboKey, "safe-combo"))).status).toBe(200);
    expect(routed()).not.toContain("gpt-pool");

    upstream.core.mockClear();
    const nestedKey = await newKey("adapter-nested", { allowedModels: ["outer-combo"] });
    expect((await handleChat(chatRequest(nestedKey, "outer-combo"))).status).toBe(200);
    expect(routed()).not.toContain("gpt-pool");

    upstream.core.mockClear();
    const plain = await newKey("adapter-combo-plain");
    await handleChat(chatRequest(plain, "safe-combo"));
    expect(routed()[0]).toBe("gpt-pool");
  });

  const media = (key, url, body) => new Request(`http://localhost${url}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` }, body: JSON.stringify(body),
  });
  it.each([
    ["embeddings", async () => (await import("@/sse/handlers/embeddings.js")).handleEmbeddings, (k) => media(k, "/v1/embeddings", { model: "openai/text-embedding-3-small", input: "hi" })],
    ["images", async () => (await import("@/sse/handlers/imageGeneration.js")).handleImageGeneration, (k) => media(k, "/v1/images/generations", { model: "openai/img", prompt: "a cat" })],
    ["speech", async () => (await import("@/sse/handlers/tts.js")).handleTts, (k) => media(k, "/v1/audio/speech", { model: "openai/tts-1", input: "hi" })],
    ["transcriptions", async () => (await import("@/sse/handlers/stt.js")).handleStt, (k) => {
      const form = new FormData();
      form.set("model", "openai/whisper-1");
      form.set("file", new Blob([new Uint8Array([1, 2, 3])]), "a.wav");
      return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${k.key}` }, body: form });
    }],
  ])("refuses a model off the list on %s before any upstream call", async (_name, load, makeRequest) => {
    const handler = await load();
    const key = await newKey("media-allowlist", { allowedModels: ["openai/gpt-a"] });
    const res = await handler(makeRequest(key));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("model_not_allowed");
    expect(upstream.credentials).not.toHaveBeenCalled();
  });

  it("every model list route shows an allowlisted key only its models", async () => {
    const modelsRoute = await import("@/app/api/v1/models/route.js");
    const all = (await modelsRoute.buildModelsList(["llm"])).map((m) => m.id);
    expect(all).toContain("safe-combo");
    expect(all.length).toBeGreaterThan(2);
    const key = await newKey("routes-filter", { allowedModels: ["safe-combo"] });
    const get = (url) => new Request(`http://localhost${url}`, { headers: { Authorization: `Bearer ${key.key}` } });

    // A combo made only of allowed combos (outer-combo, if another test made it) is allowed too.
    const onlyAllowed = (ids) => ids.length > 0 && ids.includes("safe-combo") && ids.every((id) => ["safe-combo", "outer-combo"].includes(id));
    const list = await (await modelsRoute.GET(get("/v1/models"))).json();
    expect(onlyAllowed(list.data.map((m) => m.id))).toBe(true);

    const sub = await import("@/app/api/v1/models/[...model]/route.js");
    expect((await sub.GET(get("/v1/models/mixed-combo"), { params: Promise.resolve({ model: ["mixed-combo"] }) })).status).toBe(404);
    expect((await sub.GET(get("/v1/models/safe-combo"), { params: Promise.resolve({ model: ["safe-combo"] }) })).status).toBe(200);

    const codex = await import("@/app/api/v1/codex/models/route.js");
    const codexList = await (await codex.GET(get("/backend-api/codex/models"))).json();
    expect(onlyAllowed(codexList.data.map((m) => m.id))).toBe(true);

    const gemini = await import("@/app/api/v1beta/models/route.js");
    const geminiAll = (await (await gemini.GET(new Request("http://localhost/v1beta/models"))).json()).models;
    const anyId = geminiAll[0].name.replace(/^models\//, "");
    const geminiKey = await newKey("gemini-filter", { allowedModels: [anyId] });
    const geminiList = await (await gemini.GET(new Request("http://localhost/v1beta/models", { headers: { "x-goog-api-key": geminiKey.key } }))).json();
    expect(geminiList.models.length).toBeGreaterThan(0);
    expect(geminiList.models.length).toBeLessThan(geminiAll.length);
    expect(geminiList.models.every((m) => m.name.toLowerCase().endsWith(anyId.split("/").pop().toLowerCase()))).toBe(true);
  });

  it("/v1/models lists only the allowed models for that key", async () => {
    const key = await newKey("list-filter", { allowedModels: ["claude-opus-5-5", "safe-combo"] });
    const plain = await newKey("list-plain");
    const list = [{ id: "cc/claude-opus-5-5" }, { id: "cc/claude-sonnet-5-5" }, { id: "safe-combo" }, { id: "mixed-combo" }];
    const req = (k) => new Request("http://localhost/v1/models", { headers: { Authorization: `Bearer ${k.key}` } });
    expect((await filterModelsForRequest(req(key), list)).map((m) => m.id)).toEqual(["claude-opus-5-5", "safe-combo"]);
    expect(await filterModelsForRequest(req(plain), list)).toEqual(list);
    expect(await filterModelsForRequest(new Request("http://localhost/v1/models"), list)).toEqual(list);
  });

  it("lists a bare allowed model once under its own name, hiding which providers serve it", async () => {
    const key = await newKey("list-bare", { allowedModels: ["claude-opus-5-5"] });
    const req = new Request("http://localhost/v1/models", { headers: { Authorization: `Bearer ${key.key}` } });
    const list = [
      { id: "snow/claude-opus-5-5", object: "model", owned_by: "snow" },
      { id: "cc/claude-opus-5-5", object: "model", owned_by: "cc" },
      { id: "cc/claude-sonnet-5-5", object: "model", owned_by: "cc" },
    ];
    const shown = await filterModelsForRequest(req, list);
    expect(shown).toEqual([{ id: "claude-opus-5-5", object: "model", owned_by: "10router" }]);
    expect(JSON.stringify(shown)).not.toMatch(/snow|"cc/);
  });

  it("lists a provider-prefixed allowed model as-is", async () => {
    const key = await newKey("list-prefixed", { allowedModels: ["cc/claude-opus-5-5"] });
    const req = new Request("http://localhost/v1/models", { headers: { Authorization: `Bearer ${key.key}` } });
    const list = [{ id: "snow/claude-opus-5-5" }, { id: "cc/claude-opus-5-5" }];
    expect((await filterModelsForRequest(req, list)).map((m) => m.id)).toEqual(["cc/claude-opus-5-5"]);
  });
});

describe("expiry", () => {
  it("refuses an expired key with a 401 and allows one that hasn't expired", async () => {
    const expired = await newKey("expired", { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const res = await handleChat(chatRequest(expired, "openai/gpt-a"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatchObject({ type: "authentication_error", code: "key_expired" });
    expect(body.error.message).toMatch(/expired/);
    expect(upstream.credentials).not.toHaveBeenCalled();

    const later = await newKey("later", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await handleChat(chatRequest(later, "openai/gpt-a"))).status).toBe(200);
  });
});

describe("a key sent while Require API key is off", () => {
  const withSettings = async (fn) => {
    await updateSettings({ requireApiKey: false });
    try { await fn(); } finally { await updateSettings({ requireApiKey: true }); }
  };
  const sent = (key, place) => {
    const headers = { "Content-Type": "application/json" };
    let url = "http://localhost/v1/chat/completions";
    if (place === "bearer") headers.Authorization = `Bearer ${key.key}`;
    if (place === "x-goog-api-key") headers["x-goog-api-key"] = key.key;
    if (place === "query") url += `?key=${encodeURIComponent(key.key)}`;
    return new Request(url, { method: "POST", headers, body: JSON.stringify({ model: "openai/gpt-a", messages: [{ role: "user", content: "hi" }] }) });
  };

  it.each(["bearer", "x-goog-api-key", "query"])("still has its limits enforced (key sent as %s)", async (place) => {
    await withSettings(async () => {
      const key = await newKey(`off-${place}`, { budgetUsd: 1 });
      await spend(key, 1);
      const res = await handleChat(sent(key, place));
      expect(res.status).toBe(402);
      expect(upstream.credentials).not.toHaveBeenCalled();
    });
  });

  it("handlers read the key from x-goog-api-key and ?key=, like the middleware", async () => {
    const { extractApiKey } = await import("@/sse/services/auth.js");
    const key = await newKey("goog-attribution");
    expect(extractApiKey(sent(key, "x-goog-api-key"))).toBe(key.key);
    expect(extractApiKey(sent(key, "query"))).toBe(key.key);
  });
});

describe("rate-limit hold", () => {
  it("checks the key again before re-running a held request", async () => {
    const { DEFAULT_TIMING } = await import("open-sse/utils/limitHold.js");
    const timing = { ...DEFAULT_TIMING };
    Object.assign(DEFAULT_TIMING, { minWaitMs: 10, recheckMs: 10 });
    await updateSettings({ limitHoldEnabled: true });
    try {
      const key = await newKey("held", { budgetUsd: 1 });
      // The first attempt finds every account rate-limited, and meanwhile the
      // key's other traffic uses up its budget. A re-run would succeed.
      upstream.credentials.mockImplementationOnce(async () => {
        await spend(key, 1);
        return { allRateLimited: true, retryAfter: new Date(Date.now() + 50).toISOString(), retryAfterHuman: "reset after 1s", lastError: "rate limited", lastErrorCode: 429 };
      });
      const res = await handleChat(chatRequest(key, "openai/gpt-a", { body: { stream: false } }));
      expect(res.status).toBe(402);
      expect(upstream.core).not.toHaveBeenCalled();
    } finally {
      Object.assign(DEFAULT_TIMING, timing);
      await updateSettings({ limitHoldEnabled: false });
    }
  });
});

describe("combo rate-limit hold", () => {
  const LIMITED = () => ({ allRateLimited: true, retryAfter: new Date(Date.now() + 50).toISOString(), retryAfterHuman: "reset after 1s", lastError: "rate limited", lastErrorCode: 429 });
  const withHold = async (fn) => {
    const { DEFAULT_TIMING } = await import("open-sse/utils/limitHold.js");
    const timing = { ...DEFAULT_TIMING };
    Object.assign(DEFAULT_TIMING, { minWaitMs: 10, recheckMs: 10, keepaliveMs: 5 });
    await updateSettings({ limitHoldEnabled: true });
    try { await fn(); } finally {
      Object.assign(DEFAULT_TIMING, timing);
      await updateSettings({ limitHoldEnabled: false });
    }
  };
  // Every model of the combo is rate-limited on the first pass, and meanwhile
  // the key's budget runs out. A re-run would succeed.
  const limitedOnce = (key) => {
    let calls = 0;
    upstream.credentials.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await spend(key, 1);
      return calls <= 2 ? LIMITED() : { connectionId: "conn-1", connectionName: "acct", accessToken: "t" };
    });
    upstream.core.mockImplementation(async () => ({ success: true, response: new Response(JSON.stringify({ ok: "rerun reached the upstream" }), { status: 200 }) }));
  };

  it("checks the key before re-running a held JSON combo request", async () => {
    await withHold(async () => {
      const key = await newKey("combo-held-json", { budgetUsd: 1 });
      limitedOnce(key);
      const res = await handleChat(chatRequest(key, "safe-combo", { body: { stream: false } }));
      expect(res.status).toBe(402);
      expect(upstream.core).not.toHaveBeenCalled();
    });
  });

  it("checks the key before re-running a held streaming combo request", async () => {
    await withHold(async () => {
      const key = await newKey("combo-held-stream", { budgetUsd: 1 });
      limitedOnce(key);
      const res = await handleChat(chatRequest(key, "safe-combo", { body: { stream: true } }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("budget is used up");
      expect(text).not.toContain("rerun reached the upstream");
      expect(upstream.core).not.toHaveBeenCalled();
    });
  });
});

describe("unpriced billing modes", () => {
  it("a budgeted key's request goes out without speed and service_tier; others keep them", async () => {
    const budgeted = await newKey("strip-modes", { budgetUsd: 100 });
    await handleChat(chatRequest(budgeted, "openai/gpt-a", { body: { speed: "fast", service_tier: "priority" } }));
    const sent = upstream.core.mock.calls.at(-1)[0].body;
    expect(sent).not.toHaveProperty("speed");
    expect(sent).not.toHaveProperty("service_tier");

    const plain = await newKey("keep-modes");
    await handleChat(chatRequest(plain, "openai/gpt-a", { body: { speed: "fast", service_tier: "priority" } }));
    expect(upstream.core.mock.calls.at(-1)[0].body).toMatchObject({ speed: "fast", service_tier: "priority" });
  });
});

describe("Ollama /v1/api/chat", () => {
  it("returns a refusal with its status and body instead of an empty 200", async () => {
    const { POST } = await import("@/app/api/v1/api/chat/route.js");
    const key = await newKey("ollama-over", { budgetUsd: 1 });
    await spend(key, 1);
    const res = await POST(chatRequest(key, "openai/gpt-a", { endpoint: "/v1/api/chat" }));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("key_budget_exceeded");
  });
});

describe("v1beta native TTS and video polling", () => {
  it("refuses an expired key on the Gemini native TTS passthrough before any upstream call", async () => {
    const { POST } = await import("@/app/api/v1beta/models/[...path]/route.js");
    const key = await newKey("gemini-tts-expired", { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const req = new Request("http://localhost/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key.key },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
    });
    const res = await POST(req, { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("key_expired");
    expect(upstream.credentials).not.toHaveBeenCalled();
  });

  it("video polling refuses an expired key but lets an over-budget key collect its job", async () => {
    const { handleVideoGet } = await import("@/sse/handlers/videoGeneration.js");
    const poll = (k) => new Request("http://localhost/v1/videos/req-1", { headers: { Authorization: `Bearer ${k.key}` } });
    const expired = await newKey("poll-expired", { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await handleVideoGet(poll(expired), "req-1")).status).toBe(401);
    expect(upstream.credentials).not.toHaveBeenCalled();

    const spent = await newKey("poll-spent", { budgetUsd: 1, allowedModels: ["openai/gpt-a"] });
    await spend(spent, 1);
    upstream.credentials.mockResolvedValueOnce(null);
    const res = await handleVideoGet(poll(spent), "req-1");
    expect(res.status).not.toBe(402);
    expect(res.status).not.toBe(403);
    expect(upstream.credentials).toHaveBeenCalled();
  });
});

describe("running total bookkeeping", () => {
  it("keeps the latest lastUsedAt when writes land out of order", async () => {
    const key = await newKey("out-of-order");
    await saveRequestUsage({ ...PRICED, apiKey: key.key, timestamp: "2026-05-02T00:00:00.000Z", tokens: { prompt_tokens: 10, completion_tokens: 0 } });
    await saveRequestUsage({ ...PRICED, apiKey: key.key, timestamp: "2026-05-01T00:00:00.000Z", tokens: { prompt_tokens: 10, completion_tokens: 0 } });
    expect((await getApiKeyById(key.id)).lastUsedAt).toBe("2026-05-02T00:00:00.000Z");
  });

  it("still matches SUM(cost) after a reset and after a same-install restore", async () => {
    const key = await newKey("sum-after");
    await spend(key, 1.5);
    await updateApiKey(key.id, { resetSpend: true });
    await spend(key, 0.25);
    const adapter = await getAdapter();
    const sum = () => adapter.get("SELECT SUM(cost) AS s FROM usageHistory WHERE apiKey = ?", [key.key]).s;
    let stored = await getApiKeyById(key.id);
    expect(stored.lifetimeSpentUsd).toBeCloseTo(sum(), 9);
    expect(stored.spentUsd).toBeCloseTo(0.25, 9);

    await db.importDb(await db.exportDb());
    stored = await getApiKeyById(key.id);
    expect(stored.lifetimeSpentUsd).toBeCloseTo(sum(), 9);
    expect(stored.spentUsd).toBeCloseTo(0.25, 9);
  });
});

describe("pickInternalKey", () => {
  const k = (key, extra = {}) => ({ key, isActive: true, budgetUsd: null, allowedModels: null, expiresAt: null, spentUsd: 0, ...extra });
  it("prefers an active key with no limits", () => {
    expect(pickInternalKey([k("a", { budgetUsd: 5 }), k("b", { isActive: false }), k("c")])).toBe("c");
  });
  it("with every key limited, takes one that can still be used", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(pickInternalKey([k("expired", { expiresAt: past }), k("spent", { budgetUsd: 1, spentUsd: 1 }), k("ok", { budgetUsd: 10, spentUsd: 1 })])).toBe("ok");
  });
  it("with every key expired or exhausted, falls back to the first active one, and to null with none", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(pickInternalKey([k("off", { isActive: false }), k("expired", { expiresAt: past }), k("spent", { budgetUsd: 0 })])).toBe("expired");
    expect(pickInternalKey([k("off", { isActive: false })])).toBeNull();
    expect(pickInternalKey([])).toBeNull();
  });
});

describe("GET /v1/key (self-service)", () => {
  it("shows the calling key's own limits and spend, and nothing that would let you use it", async () => {
    const mine = await newKey("holder", { budgetUsd: 2000, allowedModels: ["claude-opus-5-5"], expiresAt: "2030-01-01T00:00:00.000Z" });
    const theirs = await newKey("someone-else", { budgetUsd: 7 });
    await spend(mine, 12.5);
    await spend(theirs, 3);

    const res = await getOwnKey(new Request("http://localhost/v1/key", { headers: { Authorization: `Bearer ${mine.key}` } }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const { data } = JSON.parse(text);
    expect(data).toMatchObject({
      name: "holder", limit: 2000, allowed_models: ["claude-opus-5-5"], expires_at: "2030-01-01T00:00:00.000Z",
      expired: false, budget_exhausted: false, requests: 1,
    });
    expect(data.usage).toBeCloseTo(12.5, 6);
    expect(data.limit_remaining).toBeCloseTo(1987.5, 6);
    expect(text).not.toContain(mine.key);
    expect(text).not.toContain(theirs.key);
    expect(text).not.toContain("someone-else");
    expect(data.label.endsWith("***")).toBe(true);
  });

  it("works with an Anthropic x-api-key header", async () => {
    const mine = await newKey("x-api-key-holder", { budgetUsd: 1 });
    const res = await getOwnKey(new Request("http://localhost/v1/key", { headers: { "x-api-key": mine.key } }));
    expect((await res.json()).data.name).toBe("x-api-key-holder");
  });

  it("answers 401 for no key or a key 10router didn't issue", async () => {
    expect((await getOwnKey(new Request("http://localhost/v1/key"))).status).toBe(401);
    const res = await getOwnKey(new Request("http://localhost/v1/key", { headers: { Authorization: "Bearer not-a-real-key" } }));
    expect(res.status).toBe(401);
  });
});

describe("keys API", () => {
  const put = (id, body) => putKey(new Request(`http://localhost/api/keys/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  }), params(id));

  it("saves valid limits and returns them with the spend", async () => {
    const key = await newKey("api-edit");
    const res = await put(key.id, { budgetUsd: "2000", allowedModels: [" claude-opus-5-5 ", "claude-opus-5-5", "cc/x"], expiresAt: "2031-06-01" });
    expect(res.status).toBe(200);
    const { key: saved } = await res.json();
    expect(saved).toMatchObject({ budgetUsd: 2000, allowedModels: ["claude-opus-5-5", "cc/x"], expiresAt: "2031-06-01T00:00:00.000Z", spentUsd: 0, requestCount: 0 });

    const cleared = await (await put(key.id, { budgetUsd: null, allowedModels: [], expiresAt: null })).json();
    expect(cleared.key).toMatchObject({ budgetUsd: null, allowedModels: null, expiresAt: null });
  });

  it.each([
    [{ budgetUsd: -1 }, /non-negative/],
    [{ budgetUsd: "abc" }, /non-negative/],
    [{ budgetUsd: Number.MAX_VALUE }, /at most/],
    [{ allowedModels: "claude-opus-5-5" }, /array/],
    [{ allowedModels: ["ok", 5] }, /strings/],
    [{ expiresAt: "not a date" }, /valid date/],
    [{ expiresAt: { at: 1 } }, /ISO date/],
    [{ resetSpend: "yes" }, /true or false/],
    [{ isActive: "no" }, /true or false/],
  ])("rejects %j with a 400", async (body, message) => {
    const key = await newKey("api-invalid", { budgetUsd: 9 });
    const res = await put(key.id, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect((await getApiKeyById(key.id)).budgetUsd).toBe(9);
  });

  it("rejects a body that isn't a JSON object", async () => {
    const key = await newKey("api-bad-json");
    expect((await put(key.id, "{nope")).status).toBe(400);
    expect((await put(key.id, [1, 2])).status).toBe(400);
  });

  it("resets spend through the API", async () => {
    const key = await newKey("api-reset", { budgetUsd: 1 });
    await spend(key, 2);
    const { key: saved } = await (await put(key.id, { resetSpend: true })).json();
    expect(saved.spentUsd).toBe(0);
    expect(saved.lifetimeSpentUsd).toBeCloseTo(2, 6);
  });

  it("returns per-day and per-model spend for the detail view, without the raw key", async () => {
    const key = await newKey("api-detail");
    await spend(key, 1.25);
    await spend(key, 0.75);
    const res = await getKeyUsage(new Request(`http://localhost/api/keys/${key.id}/usage`), params(key.id));
    const text = await res.text();
    const detail = JSON.parse(text);
    expect(detail.daily).toHaveLength(30);
    expect(detail.daily.at(-1).cost).toBeCloseTo(2, 6);
    expect(detail.daily.at(-1).requests).toBe(2);
    expect(detail.byModel).toEqual([expect.objectContaining({ model: "m1", requests: 2 })]);
    expect(detail.byModel[0].cost).toBeCloseTo(2, 6);
    expect(detail.recent).toHaveLength(2);
    expect(Object.keys(detail).sort()).toEqual(["byModel", "daily", "recent"]);
    expect(text).not.toContain(key.key);
  });

  it("parseKeyLimitsInput leaves out fields that weren't sent", () => {
    expect(parseKeyLimitsInput({ name: "x" })).toEqual({ data: {}, errors: [] });
    expect(parseKeyLimitsInput({ resetSpend: false })).toEqual({ data: {}, errors: [] });
  });

  it("a blank budget clears it rather than meaning $0", async () => {
    expect(parseKeyLimitsInput({ budgetUsd: "   " })).toEqual({ data: { budgetUsd: null }, errors: [] });
    expect(parseKeyLimitsInput({ budgetUsd: " 12.5 " })).toEqual({ data: { budgetUsd: 12.5 }, errors: [] });
    const key = await newKey("blank-budget", { budgetUsd: 3 });
    const { key: saved } = await (await put(key.id, { budgetUsd: "  " })).json();
    expect(saved.budgetUsd).toBeNull();
    expect((await handleChat(chatRequest(saved, "openai/gpt-a"))).status).toBe(200);
  });
});
