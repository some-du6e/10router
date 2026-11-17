// A custom endpoint whose upstream account may not use one model answers a 403
// saying the account isn't eligible for it, from every key on that account,
// while the same keys keep serving other models. That is a refusal of the
// model, not of the key: once two keys on one upstream gave the same one, and
// no key has served the model lately, the router answers with it instead of
// walking every key. Each such key is locked on that model alone for
// MODEL_REFUSAL_STOP.lockMs, so later requests ask other keys and reach one
// whose account may use the model; once one has served it, the walk goes on
// past the refusing keys. None of those keys is turned off or demoted on other
// models for it. A dead key's generic 403 is handled as before.
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

// script: one result per upstream call, in order. Past its end, `refuser`
// (connectionId, model) may return a failure; otherwise the call succeeds.
const upstream = vi.hoisted(() => ({ calls: [], script: [], refuser: null }));
const combos = vi.hoisted(() => new Map());
const warnings = vi.hoisted(() => []);
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => {
    upstream.calls.push(`${args.connectionId}:${args.modelInfo.model}`);
    const next = upstream.script.shift() ?? upstream.refuser?.(args.connectionId, args.modelInfo.model);
    if (next) return next(args.modelInfo.model);
    await args.onRequestSuccess?.();
    return { success: true, response: new Response("{}", { status: 200 }) };
  },
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => (m.includes("/") ? { provider: m.split("/")[0], model: m.split("/")[1] } : { provider: null, model: m }),
  getComboModels: async (m) => combos.get(m) ?? null,
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
const { MODEL_REFUSAL, MODEL_REFUSAL_STOP } = await import("open-sse/config/errorConfig.js");
const { createErrorResult, formatProviderError } = await import("open-sse/utils/error.js");

const MODEL = "big-model";
const OTHER_MODEL = "big-model-mini";
const KEYS = 9;
// Paraphrased: the account behind the key may not use this one model.
const NOT_ELIGIBLE = "Under current access rules your account is not eligible for this model yet. Contact support to have it switched on.";
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
// The upstream refuses MODEL on these keys' accounts and serves everything else.
const refuseOn = (ids) => (id, model) => (model === MODEL && ids.includes(id) ? refused : null);

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
  upstream.refuser = null;
  warnings.length = 0;
  combos.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

const useClock = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T09:00:00.000Z"));
};

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

function chat(model = MODEL, { handler = handleChat, stream = false } = {}) {
  return handler(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model.includes("/") || combos.has(model) ? model : `${provider}/${model}`, stream,
      messages: [{ role: "user", content: "fix the bug" }] }),
  }));
}

// One request per `stepMs`: each one's status and upstream calls.
async function requests(count, stepMs = 3 * MIN) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) vi.advanceTimersByTime(stepMs);
    upstream.calls = [];
    const res = await chat();
    out.push({ status: res.status, calls: [...upstream.calls] });
  }
  return out;
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
const served = async (id, model = MODEL) => auth.clearAccountError(id, await load(id), model);

describe("classifying a refusal of the model for the account", () => {
  it.each([
    NOT_ELIGIBLE,
    "This account is not eligible for the model.",
    "This account is not eligible for the model",
    "Your organization does not have access to this model",
    "The model example-model is not available for your account",
    "model example-model is not enabled for this account",
  ])("is a refusal of the model, not of the key: %s", (message) => {
    const text = `[403]: ${JSON.stringify({ message })}`;
    expect(isModelRefusal(403, text)).toBe(true);
    expect(classifyError(403, text)).toBe("client_error");
  });

  // Holds only the words of the "model ... not eligible for <account>" alternative,
  // so dropping it from MODEL_REFUSAL turns this red.
  it("counts a message only the model ... not eligible for the account alternative matches", () => {
    const message = "model example-model is not eligible for this account";
    const others = [/does not have access to (?:the |this )?model/i, /model_not_found/i, /\bnot eligible for (?:this model\b|the model(?![\s-]*\w))/i,
      /\bmodel\b.{0,60}?\bnot (?:available|allowed|enabled|permitted|supported)\b/i];
    expect(others.filter((r) => r.test(message))).toEqual([]);
    expect(MODEL_REFUSAL.test(message)).toBe(true);
    expect(isModelRefusal(403, `[403]: ${message}`)).toBe(true);
  });

  it.each([
    DEAD,
    "tools.0: web search is not enabled for your organization",
    "This account is not eligible for the model service",
    "This account is not eligible for the model-serving API",
    "Model access denied: this key is not eligible for API use",
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

  it("doesn't agree on two different refusals of the model", () => {
    const tally = createSameRequestErrorTally(2);
    expect(tally.note("a", "u", 403, refusedText)).toBeNull();
    expect(tally.note("b", "u", 403, "[403]: Your organization does not have access to this model")).toBeNull();
  });

  it("needs 2 accounts even with STOP_AFTER=1: one account says nothing about another", () => {
    const tally = createSameRequestErrorTally(1);
    expect(tally.modelStopAfter).toBe(2);
    expect(tally.note("a", "u", 403, refusedText)).toBeNull();
    expect(tally.note("b", "u", 403, refusedText)).toBe("model");
  });
});

describe("a model no key's account may use", () => {
  it("answers after 2 of 9 keys with the upstream's 403, and the keys keep serving another model", async () => {
    const keys = await addKeys(KEYS);
    upstream.refuser = refuseOn(keys);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("not eligible for this model");
    expect(warnings).toContain(stopLine("key-2"));

    // Only those two are locked, only on this model, and for MODEL_REFUSAL_STOP.lockMs.
    for (const id of keys.slice(0, 2)) expect(await lockEnd(id)).toBeGreaterThan(Date.now() + MODEL_REFUSAL_STOP.lockMs - MIN);
    for (const id of keys.slice(2)) expect(await lockEnd(id)).toBe(0);

    upstream.calls = [];
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

  it("stops the same way on a streaming request", async () => {
    const keys = await addKeys(KEYS);
    upstream.refuser = refuseOn(keys);

    const res = await chat(MODEL, { stream: true });
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(403);
    expect(warnings).toContain(stopLine("key-2"));
  });

  it("asks each key once while its lock lasts, even with requests minutes apart, then fails at once", async () => {
    useClock();
    const keys = await addKeys(KEYS);
    upstream.refuser = refuseOn(keys);

    const out = await requests(6);
    expect(out.map((r) => r.calls.length)).toEqual([2, 2, 2, 2, 1, 0]);
    expect(out[1].calls).toEqual(calls(keys.slice(2, 4)));
    expect(out.every((r) => r.status === 403)).toBe(true);
  });

  it("lets a combo move on to its next model", async () => {
    const keys = await addKeys(KEYS);
    upstream.refuser = refuseOn(keys);
    combos.set("big-combo", [`${provider}/${MODEL}`, `${provider}/${OTHER_MODEL}`]);

    const res = await chat("big-combo");
    expect(res.status).toBe(200);
    expect(upstream.calls).toEqual([...calls(keys.slice(0, 2)), `${keys[0]}:${OTHER_MODEL}`]);
  });

  it("walks past dead keys' generic 403s, then stops at the second refusal of the model", async () => {
    const keys = await addKeys(KEYS);
    upstream.script = [dead, dead, dead];
    upstream.refuser = refuseOn(keys);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 5)));
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("not eligible for this model");
    expect(warnings).toContain(stopLine("key-5"));
  });

  it("still walks every key on a dead key's generic 403, as before, with the usual short lock", async () => {
    const keys = await addKeys(KEYS);
    upstream.script = Array(KEYS).fill(dead);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys));
    expect(res.status).toBe(403);
    expect(stopped()).toBe(false);
    for (const id of keys) {
      expect(await lockEnd(id)).toBeGreaterThan(Date.now());
      expect(await lockEnd(id)).toBeLessThanOrEqual(Date.now() + 2 * MIN);
    }
  });

  it("keeps walking when the keys reach different upstreams, whose accounts may differ", async () => {
    const own = (n) => ({ baseUrl: `http://upstream-${n}.example/v1`, ownBaseUrl: true });
    const keys = await addKeys(4, { 1: own(1), 2: own(2), 3: own(3), 4: own(4) });
    upstream.refuser = refuseOn(keys);

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
      upstream.refuser = refuseOn(keys);

      const res = await chat(MODEL, { handler: handleChatOff });
      expect(upstream.calls).toEqual(calls(keys));
      expect(res.status).toBe(403);
      expect(stopped()).toBe(false);
    });
  });
});

describe("keys whose accounts differ in model access, behind one URL", () => {
  it("walks past refusing keys to one that served the model lately", async () => {
    const keys = await addKeys(3);
    upstream.refuser = refuseOn(keys.slice(0, 2));
    await served(keys[2]);

    const res = await chat();
    expect(res.status).toBe(200);
    expect(upstream.calls).toEqual(calls(keys));
    expect(stopped()).toBe(false);
  });

  it("stops again once the key that served the model refuses it too", async () => {
    const keys = await addKeys(3);
    upstream.refuser = refuseOn(keys);
    await served(keys[2]);

    const res = await chat();
    expect(res.status).toBe(403);
    expect(upstream.calls).toEqual(calls(keys));
    expect(warnings).toContain("[FALLBACK] ⇄ ACC:key-3 same refusal of big-model (403) from 2 accounts, not trying the rest");
  });

  it("doesn't count a key that served the model but is turned off", async () => {
    const keys = await addKeys(4);
    upstream.refuser = refuseOn(keys.slice(0, 3));
    await served(keys[3]);
    await db.updateProviderConnection(keys[3], { isActive: false });

    const res = await chat();
    expect(res.status).toBe(403);
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
  });

  it("reaches the eligible key within ceil(keys / 2) requests minutes apart, then serves every request", async () => {
    useClock();
    const keys = await addKeys(KEYS);
    upstream.refuser = refuseOn(keys.slice(0, KEYS - 1));

    const first = await requests(Math.ceil(KEYS / 2));
    expect(first.map((r) => r.status)).toEqual([403, 403, 403, 403, 200]);
    expect(first.at(-1).calls).toEqual(calls(keys.slice(-1)));

    // An hour more, one request every 3 minutes: the refusing keys' locks end
    // on the way, and the walk passes them to the key that serves.
    vi.advanceTimersByTime(3 * MIN);
    const later = await requests(20);
    expect(later.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(later.some((r) => r.calls.length > 1)).toBe(true);
    for (const id of keys) expect((await load(id)).isActive).toBe(true);
  });

  it("after a restart (no memory of the key that served), finds it again the same way", async () => {
    useClock();
    const keys = await addKeys(KEYS);
    upstream.refuser = refuseOn(keys.slice(0, KEYS - 1));
    expect((await requests(Math.ceil(KEYS / 2))).at(-1).status).toBe(200);

    // Every refusing key's lock is over, and the process forgot who served.
    vi.advanceTimersByTime(MODEL_REFUSAL_STOP.lockMs + MIN);
    global._authEvents.success.clear();
    const again = await requests(Math.ceil(KEYS / 2));
    expect(again.map((r) => r.status)).toEqual([403, 403, 403, 403, 200]);
    expect(again[0].calls).toEqual(calls(keys.slice(0, 2)));
  });

  it("without that restart, serves the first request after the locks end", async () => {
    useClock();
    const keys = await addKeys(KEYS);
    upstream.refuser = refuseOn(keys.slice(0, KEYS - 1));
    expect((await requests(Math.ceil(KEYS / 2))).at(-1).status).toBe(200);

    vi.advanceTimersByTime(MODEL_REFUSAL_STOP.lockMs + MIN);
    const [next] = await requests(1);
    expect(next.status).toBe(200);
    expect(next.calls).toEqual(calls(keys));
  });
});

describe("a key refused that way while another account serves the model", () => {
  beforeEach(useClock);

  const refuse = (id, model, onProvider = provider) => auth.markAccountUnavailable(id, 403, refusedText, onProvider, model);

  it("is never turned off, however many models it is refused on", async () => {
    const [key, peer] = await addKeys(2);
    for (let i = 0; i < 6; i++) {
      if (i > 0) vi.advanceTimersByTime(3 * MIN);
      const model = ["m1", "m2"][i % 2];
      await served(peer, model);
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
      await served(peer, "m1");
      await refuse(key, "m1");
    }

    expect((await load(key))[db.getAuthDemoteKey("m1")]).toMatchObject({ modelScoped: true, demotedAt: expect.any(String) });
    expect((await demotions(key)).map(([k]) => k)).toEqual([db.getAuthDemoteKey("m1")]);
    expect((await auth.getProviderCredentials(provider, null, "m3")).connectionId).toBe(key);
    expect((await auth.getProviderCredentials(provider, null, "m1")).connectionId).toBe(peer);
  });

  it("is locked for the usual 2 minutes on a built-in provider", async () => {
    provider = `builtin-test-${providerSeq}`;
    const [key] = await addKeys(1);
    const { cooldownMs } = await refuse(key, "m1");
    expect(cooldownMs).toBe(2 * MIN);
  });
});
