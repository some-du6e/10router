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

const upstream = { credentials: vi.fn(), core: vi.fn() };

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

const db = await import("@/lib/db/index.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const { saveRequestUsage, updateSettings, createApiKey, updateApiKey, getApiKeyById, createCombo, setModelAlias, updatePricing } = db;
const { handleChat } = await import("@/sse/handlers/chat.js");
const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
const { checkApiKeyLimits, filterModelsForRequest } = await import("@/sse/services/keyLimits.js");
const { GET: getOwnKey } = await import("@/app/api/v1/key/route.js");
const { PUT: putKey } = await import("@/app/api/keys/[id]/route.js");
const { GET: getKeyUsage } = await import("@/app/api/keys/[id]/usage/route.js");
const { parseKeyLimitsInput, isModelAllowed, budgetState } = await import("@/shared/utils/apiKeyLimits.js");

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
    const lookup = { aliases: { fast: "cc/claude-opus-5-5" }, getComboModels: async (n) => (n === "c" ? ["cc/claude-opus-5-5"] : null) };
    expect(await isModelAllowed("cc/claude-opus-5-5", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("claude-opus-5-5[1m]", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("CC/Claude-Opus-5-5", ["cc/claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("other/claude-opus-5-5", ["cc/claude-opus-5-5"], lookup)).toBe(false);
    expect(await isModelAllowed("claude-sonnet-5-5", ["claude-opus-5-5"], lookup)).toBe(false);
    expect(await isModelAllowed("fast", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("c", ["claude-opus-5-5"], lookup)).toBe(true);
    expect(await isModelAllowed("anything", null, lookup)).toBe(true);
  });

  it("/v1/models lists only the allowed models for that key", async () => {
    const key = await newKey("list-filter", { allowedModels: ["claude-opus-5-5", "safe-combo"] });
    const plain = await newKey("list-plain");
    const list = [{ id: "cc/claude-opus-5-5" }, { id: "cc/claude-sonnet-5-5" }, { id: "safe-combo" }, { id: "mixed-combo" }];
    const req = (k) => new Request("http://localhost/v1/models", { headers: { Authorization: `Bearer ${k.key}` } });
    expect((await filterModelsForRequest(req(key), list)).map((m) => m.id)).toEqual(["cc/claude-opus-5-5", "safe-combo"]);
    expect(await filterModelsForRequest(req(plain), list)).toEqual(list);
    expect(await filterModelsForRequest(new Request("http://localhost/v1/models"), list)).toEqual(list);
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
    expect(detail.budget.spentUsd).toBeCloseTo(2, 6);
    expect(text).not.toContain(key.key);
  });

  it("parseKeyLimitsInput leaves out fields that weren't sent", () => {
    expect(parseKeyLimitsInput({ name: "x" })).toEqual({ data: {}, errors: [] });
    expect(parseKeyLimitsInput({ resetSpend: false })).toEqual({ data: {}, errors: [] });
  });
});
