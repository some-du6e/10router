// A custom endpoint whose upstream account may not use one model ("this account
// is not eligible for this model") answers that 403 from every healthy key,
// while the same keys keep serving other models. That is a refusal of the
// model, not of the key: once two keys on one upstream gave the same one, the
// router answers with it instead of walking every key, and none of those keys
// is turned off or demoted on other models for it. A dead key's generic 403
// is handled as before.
//
// Runs the real account loop (handleChat → auth.js against a temporary
// database); only the upstream call (handleChatCore) is stubbed, returning what
// chatCore builds from an upstream error (createErrorResult + formatProviderError).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-model-refusal-stop-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

// script: one result per upstream call, in order; past its end every call succeeds.
const upstream = vi.hoisted(() => ({ calls: [], script: [] }));
const warnings = vi.hoisted(() => []);
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => {
    upstream.calls.push(`${args.connectionId}:${args.modelInfo.model}`);
    const next = upstream.script.shift();
    if (next) return next(args.modelInfo.model);
    await args.onRequestSuccess?.();
    return { success: true, response: new Response("{}", { status: 200 }) };
  },
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => (m.includes("/") ? { provider: m.split("/")[0], model: m.split("/")[1] } : { provider: null, model: m }),
  getComboModels: async () => null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("@/sse/utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  warn: (tag, message) => { warnings.push(`[${tag}] ${message}`); },
}));

const db = await import("@/lib/db/index.js");
const auth = await import("@/sse/services/auth.js");
const { handleChat } = await import("@/sse/handlers/chat.js");
const { modelRefusalSignature, createSameRequestErrorTally } = await import("open-sse/services/sameRequestError.js");
const { isModelRefusal, classifyError } = await import("open-sse/utils/errorClass.js");
const { createErrorResult, formatProviderError } = await import("open-sse/utils/error.js");

const MODEL = "big-model";
const OTHER_MODEL = "big-model-mini";
const KEYS = 9;
// Paraphrased: the account behind the keys may not use this one model.
const NOT_ELIGIBLE = "Model access rules mean this account is not eligible for this model for now. Ask support about turning this model on.";
// A dead key's generic refusal.
const DEAD = "Key barred from this endpoint";
const MIN = 60 * 1000;
const stopped = () => warnings.some((w) => w.includes("not trying the rest"));
const stopLine = (account) => `[FALLBACK] ⇄ ACC:${account} same refusal of ${MODEL} (403) from 2 accounts, not trying the rest`;
let providerSeq = 0;
let provider;

// A failed upstream call as chatCore hands it back: the upstream's JSON body behind "[status]: ".
function failure(status, message) {
  return (model) => createErrorResult(status, formatProviderError(new Error(JSON.stringify({ message })), provider, model, status));
}
const refused = failure(403, NOT_ELIGIBLE);
const dead = failure(403, DEAD);
// The error text markAccountUnavailable gets for that refusal.
const refusedText = `[403]: ${JSON.stringify({ message: NOT_ELIGIBLE })}`;

beforeAll(async () => {
  await db.updateSettings({ requireApiKey: false, limitHoldEnabled: false });
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(() => {
  // A fresh provider (and keys) per test, so no lock or demotion leaks between tests.
  provider = `openai-compatible-gateway-${++providerSeq}`;
  upstream.calls = [];
  upstream.script = [];
  warnings.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// psd: providerSpecificData by key number (1-based).
async function addKeys(count, psd = {}) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const conn = await db.createProviderConnection({
      provider, authType: "apikey", name: `key-${i + 1}`, apiKey: `placeholder-${i + 1}`, priority: i + 1, isActive: true,
      ...(psd[i + 1] ? { providerSpecificData: psd[i + 1] } : {}),
    });
    ids.push(conn.id);
  }
  return ids;
}

function chat(model = MODEL, handler = handleChat) {
  return handler(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: `${provider}/${model}`, stream: false, messages: [{ role: "user", content: "fix the bug" }] }),
  }));
}

const calls = (ids, model = MODEL) => ids.map((id) => `${id}:${model}`);
const errorOf = async (res) => (await res.clone().json()).error?.message || "";
const load = (id) => db.getProviderConnectionById(id);
async function lockEnd(id, model = MODEL) {
  return new Date((await load(id))?.[`modelLock_${model}`] || 0).getTime();
}
// Every demotion record the key holds, on any model.
async function demotions(id) {
  const conn = await load(id);
  return Object.entries(conn).filter(([k, v]) => k.startsWith(db.AUTH_DEMOTE_PREFIX) && v);
}

describe("classifying a refusal of the model for the account", () => {
  it.each([
    NOT_ELIGIBLE,
    "This account is not eligible for the model.",
    "Your organization does not have access to this model",
    "The model example-model is not available for your account",
    "model example-model is not enabled for this account",
  ])("is a refusal of the model, not of the key: %s", (message) => {
    const text = `[403]: ${JSON.stringify({ message })}`;
    expect(isModelRefusal(403, text)).toBe(true);
    expect(classifyError(403, text)).toBe("client_error");
  });

  it.each([
    DEAD,
    "tools.0: web search is not enabled for your organization",
    "This account is not eligible for this model on your current plan",
    "Rate limit: this account is not eligible for this model right now",
  ])("is not one for a key refusal, a feature or a limit: %s", (message) => {
    expect(isModelRefusal(403, `[403]: ${JSON.stringify({ message })}`)).toBe(false);
  });

  it("counts only 403s", () => {
    for (const status of [400, 401, 404, 429]) expect(modelRefusalSignature(status, `[${status}]: ${NOT_ELIGIBLE}`)).toBeNull();
    expect(modelRefusalSignature(403, refusedText)).toBe(modelRefusalSignature(403, `[403]: ${JSON.stringify({ message: NOT_ELIGIBLE, id: "call-2" })}`));
  });

  it("agrees once two accounts gave the same refusal, and never with STOP_AFTER=0", () => {
    const tally = createSameRequestErrorTally(2);
    expect(tally.note("a", "u", 403, refusedText)).toBeNull();
    expect(tally.note("a", "u", 403, refusedText)).toBeNull();
    expect(tally.note("b", "u", 403, `[403]: ${DEAD}`)).toBeNull();
    expect(tally.note("c", "u", 403, refusedText)).toBe("model");
    expect(createSameRequestErrorTally(0).note("a", "u", 403, refusedText)).toBeNull();
  });
});

describe("a model the upstream account may not use", () => {
  it("answers after 2 of 9 keys with the upstream's 403, and the keys keep serving another model", async () => {
    const keys = await addKeys(KEYS);
    upstream.script = Array(KEYS).fill(refused);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("not eligible for this model");
    expect(warnings).toContain(stopLine("key-2"));

    // Only those two are locked, and only on this model.
    expect(await lockEnd(keys[0])).toBeGreaterThan(Date.now());
    expect(await lockEnd(keys[1])).toBeGreaterThan(Date.now());
    for (const id of keys.slice(2)) expect(await lockEnd(id)).toBe(0);

    // The upstream serves the other model on every key.
    upstream.calls = [];
    upstream.script = [];
    const other = await chat(OTHER_MODEL);
    expect(other.status).toBe(200);
    expect(upstream.calls).toEqual(calls(keys.slice(0, 1), OTHER_MODEL));

    for (const id of keys) {
      const conn = await load(id);
      expect(conn.isActive).toBe(true);
      expect(conn.autoDisabledAt ?? null).toBeNull();
      expect(conn.authFailCount ?? null).toBeNull();
      expect(await demotions(id)).toEqual([]);
      expect(await lockEnd(id, OTHER_MODEL)).toBe(0);
    }
  });

  it("asks each key at most once while its lock lasts: later requests try 2 new keys, then none", async () => {
    const keys = await addKeys(KEYS);
    upstream.script = Array(KEYS).fill(refused);

    const perRequest = [];
    for (let i = 0; i < 6; i++) {
      upstream.calls = [];
      const res = await chat();
      expect(res.status).not.toBe(200);
      perRequest.push(upstream.calls.length);
      if (i === 1) expect(upstream.calls).toEqual(calls(keys.slice(2, 4)));
    }
    expect(perRequest).toEqual([2, 2, 2, 2, 1, 0]);
  });

  it("walks past dead keys' generic 403s, then stops at the second refusal of the model", async () => {
    const keys = await addKeys(KEYS);
    upstream.script = [dead, dead, dead, ...Array(KEYS - 3).fill(refused)];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 5)));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("not eligible for this model");
    expect(warnings).toContain(stopLine("key-5"));
  });

  it("still walks every key on a dead key's generic 403, as before", async () => {
    const keys = await addKeys(KEYS);
    upstream.script = Array(KEYS).fill(dead);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys));
    expect(res.status).toBe(403);
    expect(stopped()).toBe(false);
    for (const id of keys) expect(await lockEnd(id)).toBeGreaterThan(Date.now());
  });

  it("serves the request from a key whose account may use the model", async () => {
    const keys = await addKeys(KEYS);
    upstream.script = [refused];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(200);
    expect(stopped()).toBe(false);
  });

  it("keeps walking when the keys reach different upstreams, whose accounts may differ", async () => {
    const own = (n) => ({ baseUrl: `http://upstream-${n}.example/v1`, ownBaseUrl: true });
    const keys = await addKeys(4, { 1: own(1), 2: own(2), 3: own(3), 4: own(4) });
    upstream.script = Array(4).fill(refused);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys));
    expect(res.status).toBe(403);
    expect(stopped()).toBe(false);
  });

  describe("with SAME_REQUEST_ERROR_STOP_AFTER=0", () => {
    let handleChatOff;
    beforeAll(async () => {
      vi.stubEnv("SAME_REQUEST_ERROR_STOP_AFTER", "0");
      vi.resetModules();
      ({ handleChat: handleChatOff } = await import("@/sse/handlers/chat.js"));
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("tries every key, as before", async () => {
      const keys = await addKeys(KEYS);
      upstream.script = Array(KEYS).fill(refused);

      const res = await chat(MODEL, handleChatOff);
      expect(upstream.calls).toEqual(calls(keys));
      expect(res.status).toBe(403);
      expect(stopped()).toBe(false);
    });
  });
});

describe("a key refused that way while another account serves the model", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T09:00:00.000Z"));
  });

  const succeed = async (id, model) => auth.clearAccountError(id, await load(id), model);
  const refuse = (id, model) => auth.markAccountUnavailable(id, 403, refusedText, provider, model);

  it("is never turned off, however many models it is refused on", async () => {
    const [key, peer] = await addKeys(2);
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(3 * MIN);
      const model = ["m1", "m2"][i % 2];
      await succeed(peer, model);
      await refuse(key, model);
    }

    const conn = await load(key);
    expect(conn.isActive).toBe(true);
    expect(conn.autoDisabledAt ?? null).toBeNull();
    expect(conn.authFailCount ?? null).toBeNull();
  });

  it("is demoted on that model alone, and still goes first on other models", async () => {
    const [key, peer] = await addKeys(2);
    for (let i = 0; i < 5; i++) {
      if (i > 0) vi.advanceTimersByTime(3 * MIN);
      await succeed(peer, "m1");
      await refuse(key, "m1");
    }

    expect((await load(key))[db.getAuthDemoteKey("m1")]).toMatchObject({ modelScoped: true, demotedAt: expect.any(String) });
    expect((await demotions(key)).map(([k]) => k)).toEqual([db.getAuthDemoteKey("m1")]);
    expect((await auth.getProviderCredentials(provider, null, "m3")).connectionId).toBe(key);
    expect((await auth.getProviderCredentials(provider, null, "m1")).connectionId).toBe(peer);
  });
});
