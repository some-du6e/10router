// A request every key refuses the same way (a prompt longer than the model's
// context window, a tool schema the upstream rejects) stops the account walk
// once two keys gave the same 400/413/422 message, instead of costing one
// upstream call per key before failing with that error anyway.
//
// Runs the real account loop (handleChat → auth.js against a temporary
// database); only the upstream call (handleChatCore) is stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-same-request-error-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

// script: one result per upstream call, in order; past its end every call succeeds.
const upstream = vi.hoisted(() => ({ calls: [], script: [] }));
const combos = vi.hoisted(() => new Map());
const warnings = vi.hoisted(() => []);
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => {
    upstream.calls.push(`${args.connectionId}:${args.modelInfo.model}`);
    const next = upstream.script.shift();
    if (next) return next(args.body?.stream === true);
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
const { handleChat } = await import("@/sse/handlers/chat.js");
const { normalizeErrorMessage, requestErrorSignature, createSameRequestErrorTally } = await import("open-sse/services/sameRequestError.js");
const { SAME_REQUEST_ERROR_STOP_AFTER } = await import("open-sse/config/runtimeConfig.js");

const MODEL = "big-model";
const OTHER_MODEL = "big-model-mini";
const STOP_LINE = "[FALLBACK] same request error from 2 accounts, not trying the rest";
// What chatCore returns when the executor's header timer fired (pinned in chat-core-failure-detail.test.js).
const NO_HEADERS = "[504]: upstream sent no response headers in 240s (headers timeout, set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS)";
let providerSeq = 0;
let provider;

// A failed upstream call as chatCore hands it back: "[status]: message", and the error body.
function failure(status, message) {
  return () => ({
    success: false,
    status,
    error: `[${status}]: ${message}`,
    response: new Response(JSON.stringify({ error: { message: `[${status}]: ${message}` } }), { status }),
  });
}

function noHeaders(stream) {
  return {
    success: false,
    status: 504,
    error: NO_HEADERS,
    headersTimeout: { stream },
    response: new Response(JSON.stringify({ error: { message: NO_HEADERS } }), { status: 504 }),
  };
}

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
  // A fresh provider (and keys) per test, so no lock or hang state leaks between tests.
  provider = `openai-compatible-gateway-${++providerSeq}`;
  upstream.calls = [];
  upstream.script = [];
  warnings.length = 0;
  combos.clear();
});

async function addKeys(count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const conn = await db.createProviderConnection({
      provider, authType: "apikey", name: `key-${i + 1}`, apiKey: `placeholder-${i + 1}`, priority: i + 1, isActive: true,
    });
    ids.push(conn.id);
  }
  return ids;
}

function chat(model = `${provider}/${MODEL}`) {
  return handleChat(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "fix the bug" }] }),
  }));
}

const calls = (ids) => ids.map((id) => `${id}:${MODEL}`);
const errorOf = async (res) => (await res.clone().json()).error?.message || "";
async function lockEnd(id) {
  const conn = (await db.getProviderConnections({ provider })).find((c) => c.id === id);
  return new Date(conn?.[`modelLock_${MODEL}`] || 0).getTime();
}

describe("normalizing a request error", () => {
  it("collapses digits, case and whitespace", () => {
    expect(normalizeErrorMessage("Input too large:   1353431 units\n> 1000000")).toBe("input too large: # units > #");
    expect(normalizeErrorMessage("too long: 1353431")).toBe(normalizeErrorMessage("too long: 1353500"));
  });

  it("cuts the message to 200 characters", () => {
    expect(normalizeErrorMessage("x".repeat(500))).toHaveLength(200);
  });

  it("reads an error object as its JSON", () => {
    expect(normalizeErrorMessage({ error: { message: "Tool definition rejected" } })).toBe('{"error":{"message":"tool definition rejected"}}');
    expect(normalizeErrorMessage(undefined)).toBe("");
  });

  it("counts only 400, 413 and 422, and not one about the key or a limit", () => {
    for (const status of [400, 413, 422]) expect(requestErrorSignature(status, "tool definition rejected")).not.toBeNull();
    for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) expect(requestErrorSignature(status, "tool definition rejected")).toBeNull();
    expect(requestErrorSignature(400, "rate limit exceeded")).toBeNull();
    expect(requestErrorSignature(400, "invalid api key")).toBeNull();
  });

  it("stops at the configured count of distinct accounts", () => {
    expect(SAME_REQUEST_ERROR_STOP_AFTER).toBe(2);
    const tally = createSameRequestErrorTally();
    expect(tally.note("a", 400, "too long: 1")).toBe(false);
    // The same account again is still one account.
    expect(tally.note("a", 400, "too long: 2")).toBe(false);
    expect(tally.note("b", 422, "too long: 3")).toBe(false);
    expect(tally.note("b", 400, "too long: 4")).toBe(true);
    expect(createSameRequestErrorTally(0).note("a", 400, "x")).toBe(false);
  });
});

describe("the same request error from two accounts", () => {
  it("stops after 2 of 5 keys and answers with the upstream's 400", async () => {
    const keys = await addKeys(5);
    upstream.script = Array(5).fill(failure(400, "input too large: 12345 units"));

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("[400]: input too large: 12345 units");
    expect(warnings).toContain(STOP_LINE);
    // A custom endpoint locks no key for a request error, as before.
    for (const id of keys) expect(await lockEnd(id)).toBe(0);
  });

  it("counts the same message with different numbers as the same", async () => {
    const keys = await addKeys(5);
    upstream.script = [failure(400, "input too large: 1353431 units"), failure(400, "input too large: 1353500 units")];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("[400]: input too large: 1353500 units");
  });

  it("stops the same way on a 413 or a 422", async () => {
    for (const status of [413, 422]) {
      provider = `openai-compatible-gateway-${++providerSeq}`;
      upstream.calls = [];
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(status, "payload rejected: 98765 bytes"));

      const res = await chat();
      expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
      expect(res.status).toBe(status);
    }
  });

  it("keeps walking when the keys give different messages", async () => {
    const keys = await addKeys(5);
    upstream.script = [
      failure(400, "tool definition rejected"),
      failure(400, "model not enabled here"),
      failure(400, "unknown field in request"),
      failure(400, "unsupported option"),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys));
    expect(res.status).toBe(200);
    expect(warnings).not.toContain(STOP_LINE);
  });

  it("doesn't count a 429 between the two", async () => {
    const keys = await addKeys(5);
    upstream.script = [
      failure(400, "input too large: 12345 units"),
      failure(429, "rate limit exceeded"),
      failure(400, "input too large: 12399 units"),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(400);
  });

  it("doesn't count a 400 that names a rate limit", async () => {
    const keys = await addKeys(5);
    upstream.script = Array(5).fill(failure(400, "rate limit exceeded"));

    await chat();
    expect(upstream.calls).toEqual(calls(keys));
  });

  it("lets a combo move on to its next model", async () => {
    const keys = await addKeys(5);
    combos.set("big-combo", [`${provider}/${MODEL}`, `${provider}/${OTHER_MODEL}`]);
    upstream.script = Array(2).fill(failure(400, "input too large: 12345 units"));

    const res = await chat("big-combo");
    expect(res.status).toBe(200);
    expect(upstream.calls).toEqual([...calls(keys.slice(0, 2)), `${keys[0]}:${OTHER_MODEL}`]);
  });
});

describe("errors that don't stop the walk", () => {
  for (const [label, status, message] of [
    ["401", 401, "invalid credentials"],
    ["403", 403, "not authorized"],
    ["500", 500, "upstream error"],
    ["503", 503, "upstream error"],
  ]) {
    it(`tries all 5 keys on a ${label} from each`, async () => {
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(status, message));

      const res = await chat();
      expect(upstream.calls).toEqual(calls(keys));
      expect(res.status).toBe(status);
      expect(warnings).not.toContain(STOP_LINE);
    });
  }

  it("keeps the header-timeout cap of 2 keys", async () => {
    const keys = await addKeys(5);
    upstream.script = Array(5).fill(noHeaders);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(504);
    expect(warnings).not.toContain(STOP_LINE);
  });
});
