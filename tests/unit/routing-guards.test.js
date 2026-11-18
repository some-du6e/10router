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

const upstream = { credentials: vi.fn(), core: vi.fn(), mark: vi.fn(), comboLookups: 0 };

vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    getProviderCredentials: (...args) => upstream.credentials(...args),
    markAccountUnavailable: (...args) => upstream.mark(...args),
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
const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");
const { handleEmbeddings } = await import("@/sse/handlers/embeddings.js");
const { handleTts } = await import("@/sse/handlers/tts.js");
const { handleStt } = await import("@/sse/handlers/stt.js");
const { handleSystemone } = await import("@/sse/handlers/systemone.js");
const { DEFAULT_TIMING } = await import("open-sse/utils/limitHold.js");
const { MAX_COMBO_DEPTH } = await import("open-sse/config/runtimeConfig.js");

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
  // Five deep: d5 is one level past the cap, so d1 falls through to shallow.
  await db.createCombo({ name: "d1", models: ["d2", "openai/shallow"] });
  await db.createCombo({ name: "d2", models: ["d3"] });
  await db.createCombo({ name: "d3", models: ["d4"] });
  await db.createCombo({ name: "d4", models: ["d5"] });
  await db.createCombo({ name: "d5", models: ["openai/deep"] });
  // Exactly at the cap: c4 still routes.
  await db.createCombo({ name: "c1", models: ["c2"] });
  await db.createCombo({ name: "c2", models: ["c3"] });
  await db.createCombo({ name: "c3", models: ["c4"] });
  await db.createCombo({ name: "c4", models: ["openai/at-cap"] });
  await db.setModelAlias("fast", "openai/model-ok");
  await db.setModelAlias("Fast", "anthropic/model-denied");
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
  upstream.mark.mockReset();
  upstream.mark.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
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
    // One lookup per combo on the way: loopy, then the repeat it refuses.
    expect(upstream.comboLookups).toBe(2);
  });

  it("stops a cycle through another combo too", async () => {
    const key = await newKey("mutual-cycle");
    const res = await handleChat(chatRequest(key, "ping"));
    expect(res.status).toBe(200);
    expect(reached()).toEqual(["openai/gpt-after-ping"]);
    // ping, pong, then the repeated ping it refuses.
    expect(upstream.comboLookups).toBe(3);
  });
});

describe("combos nested past the cap", () => {
  it(`skips a combo nested more than ${MAX_COMBO_DEPTH} deep and reaches the next member`, async () => {
    const key = await newKey("too-deep");
    const res = await handleChat(chatRequest(key, "d1"));
    expect(res.status).toBe(200);
    expect(reached()).toEqual(["openai/shallow"]);
  });

  it("routes a combo exactly at the cap, for a key whose allowlist covers its model", async () => {
    const key = await newKey("at-cap", { allowedModels: ["openai/at-cap"] });
    const res = await handleChat(chatRequest(key, "c1"));
    expect(res.status).toBe(200);
    expect(reached()).toEqual(["openai/at-cap"]);
  });

  it("lets an allowlisted key through a combo whose too-deep member reaches nothing", async () => {
    const key = await newKey("too-deep-allowlist", { allowedModels: ["openai/shallow"] });
    const res = await handleChat(chatRequest(key, "d1"));
    expect(res.status).toBe(200);
    expect(reached()).toEqual(["openai/shallow"]);
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

describe("a model id no upstream can be asked for", () => {
  // "gemini/" is an empty id: a lock on it would cover every model of the
  // account. "__all", "websearch:…" and "webfetch:…" are the router's own lock names.
  for (const model of ["gemini/", "gemini/%2e%2e", "azure/.", "openai/__all", "gemini/websearch:gemini", "ollama/webfetch:ollama"]) {
    it(`refuses chat to ${model} with a 400, locking no account`, async () => {
      const key = await newKey(`bad-id-${model}`);
      const res = await handleChat(chatRequest(key, model));
      expect(res.status).toBe(400);
      expect(upstream.credentials).not.toHaveBeenCalled();
      expect(upstream.core).not.toHaveBeenCalled();
      expect(upstream.mark).not.toHaveBeenCalled();
    });
  }

  it("routes a self-hosted chat id with a leading or inner slash (escaped as one segment)", async () => {
    const key = await newKey("leading-slash-id");
    for (const model of ["openai//models/served-model", "openai/models//x"]) {
      upstream.core.mockClear();
      const res = await handleChat(chatRequest(key, model));
      expect(res.status).toBe(200);
      expect(reached()).toEqual([model]);
    }
  });

  it("locks no account for an embeddings request its provider can't build", async () => {
    // Gemini embeddings strips "models/", leaving nothing to put in the URL.
    const key = await newKey("unbuildable-embedding");
    upstream.credentials.mockReset();
    upstream.credentials
      .mockResolvedValueOnce({ connectionId: "conn-1", connectionName: "acct", apiKey: "upstream-key" })
      .mockResolvedValue(null);
    const res = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ model: "gemini/models/", input: "hi" }),
    }));
    expect(res.status).toBe(400);
    expect(upstream.mark).not.toHaveBeenCalled();
  });

  it("stops when an unbuildable request's connection can't be excluded (a no-auth virtual one)", async () => {
    const key = await newKey("unbuildable-noauth");
    upstream.credentials.mockReset();
    // A virtual connection: no id, and it comes back whatever is excluded.
    // Bounded, so a regression fails here instead of looping forever.
    const virtual = { id: "noauth", connectionName: "local", apiKey: "upstream-key" };
    upstream.credentials.mockResolvedValueOnce(virtual).mockResolvedValueOnce(virtual).mockResolvedValue(null);
    const res = await handleEmbeddings(new Request("http://localhost/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ model: "gemini/models/", input: "hi" }),
    }));
    expect(res.status).toBe(400);
    expect(upstream.credentials).toHaveBeenCalledTimes(1);
    expect(upstream.mark).not.toHaveBeenCalled();
  });

  it("stops an unbuildable image request on a no-auth virtual connection too", async () => {
    const key = await newKey("unbuildable-image-noauth");
    upstream.credentials.mockReset();
    // No accountId: the Cloudflare adapter can't build the URL.
    const virtual = { id: "noauth", connectionName: "local", apiKey: "upstream-key" };
    upstream.credentials.mockResolvedValueOnce(virtual).mockResolvedValueOnce(virtual).mockResolvedValue(null);
    const res = await handleImageGeneration(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ model: "cloudflare-ai/@cf/vendor/model-a", prompt: "a cat" }),
    }));
    expect(res.status).toBe(400);
    expect(upstream.credentials).toHaveBeenCalledTimes(1);
    expect(upstream.mark).not.toHaveBeenCalled();
  });

  it("refuses one for System One too", async () => {
    const key = await newKey("bad-id-systemone");
    const res = await handleSystemone(new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ model: "openrouter/", state: {}, questions: { q: "?" } }),
    }));
    expect(res.status).toBe(400);
    expect(upstream.credentials).not.toHaveBeenCalled();
    expect(upstream.mark).not.toHaveBeenCalled();
  });

  it("refuses one for images, embeddings, text-to-speech and transcription too", async () => {
    const key = await newKey("bad-id-media");
    const json = (path, body) => new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
      body: JSON.stringify(body),
    });
    const form = new FormData();
    form.append("model", "gemini/");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "a.wav", { type: "audio/wav" }));
    const responses = [
      await handleImageGeneration(json("/v1/images/generations", { model: "huggingface/", prompt: "a cat" })),
      await handleImageGeneration(json("/v1/images/generations", { model: "cloudflare-ai/@cf/%2e%2e/x", prompt: "a cat" })),
      await handleEmbeddings(json("/v1/embeddings", { model: "gemini/%2e%2e", input: "hi" })),
      await handleTts(json("/v1/audio/speech", { model: "elevenlabs/eleven_v2/..", input: "hi" })),
      await handleStt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key.key}` }, body: form })),
    ];
    expect(responses.map((r) => r.status)).toEqual([400, 400, 400, 400, 400]);
    expect(upstream.credentials).not.toHaveBeenCalled();
    expect(upstream.mark).not.toHaveBeenCalled();
  });
});

describe("an allowlist naming an alias", () => {
  it("allows only the alias spelled that way, not one differing by case", async () => {
    const key = await newKey("case-alias", { allowedModels: ["fast"] });
    expect((await handleChat(chatRequest(key, "fast"))).status).toBe(200);
    expect(reached()).toEqual(["openai/model-ok"]);
    upstream.core.mockClear();
    expect((await handleChat(chatRequest(key, "Fast"))).status).toBe(403);
    expect(upstream.core).not.toHaveBeenCalled();
  });
});
