// On a custom endpoint, a request every key refuses the same way (a prompt
// longer than the model's context window, a tool schema the upstream rejects)
// stops the account walk once two keys gave the same 400/413/422 message,
// instead of costing one upstream call per key before failing with that error
// anyway. Built-in providers keep walking every key.
//
// Runs the real account loop (handleChat → auth.js against a temporary
// database); only the upstream call (handleChatCore) is stubbed, returning what
// chatCore builds from an upstream error (createErrorResult + formatProviderError).
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
const { createErrorResult, formatProviderError } = await import("open-sse/utils/error.js");

const MODEL = "big-model";
const OTHER_MODEL = "big-model-mini";
const TOO_LONG = "prompt is too long: 12345 tokens > 10000 maximum";
// What chatCore returns when the executor's header timer fired (pinned in chat-core-failure-detail.test.js).
const NO_HEADERS = "[504]: upstream sent no response headers in 240s (headers timeout, set by UPSTREAM_STREAM_HEADERS_TIMEOUT_MS)";
const stopLine = (account, status = 400) => `[FALLBACK] ⇄ ACC:${account} same request error (${status}) from 2 accounts, not trying the rest`;
const stopped = () => warnings.some((w) => w.includes("not trying the rest"));
let providerSeq = 0;
let provider;

// A failed upstream call as chatCore hands it back: the upstream body (text or
// raw JSON, as BaseExecutor.parseError passes it on) behind "[status]: ".
function failure(status, body) {
  return () => createErrorResult(status, formatProviderError(new Error(body), provider, MODEL, status));
}

// A JSON error body, as a Claude-format gateway sends it, with a per-call id.
function jsonBody(message, requestId) {
  return JSON.stringify({ type: "error", error: { type: "invalid_request_error", message }, request_id: requestId });
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

function chat(model = `${provider}/${MODEL}`, handler = handleChat) {
  return handler(new Request("http://localhost/v1/chat/completions", {
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
  it("collapses digits, case and whitespace, and drops chatCore's status prefix", () => {
    expect(normalizeErrorMessage("[400]: Prompt is too long:   12345 tokens\n> 10000 maximum")).toBe("prompt is too long: # tokens > # maximum");
    expect(normalizeErrorMessage("too long: 12345")).toBe(normalizeErrorMessage("too long: 12399"));
  });

  it("reads a JSON body's message, so a per-call request id doesn't count", () => {
    const a = `[400]: ${jsonBody(TOO_LONG, "req_placeholder_aaaa")}`;
    const b = `[400]: ${jsonBody("prompt is too long: 12399 tokens > 10000 maximum", "req_placeholder_bbbb")}`;
    expect(normalizeErrorMessage(a)).toBe("prompt is too long: # tokens > # maximum");
    expect(normalizeErrorMessage(a)).toBe(normalizeErrorMessage(b));
    // error.message, then message, then error, as parseUpstreamError reads them.
    expect(normalizeErrorMessage('{"message":"Unknown field","id":"x1"}')).toBe("unknown field");
    expect(normalizeErrorMessage('{"error":"Unknown field","id":"x1"}')).toBe("unknown field");
    expect(normalizeErrorMessage('{"id":"x1"}')).toBe('{"id":"x#"}');
    expect(normalizeErrorMessage(undefined)).toBe("");
  });

  it("doesn't let two messages that differ late in the text compare equal", () => {
    const prefix = "x".repeat(500);
    expect(normalizeErrorMessage(`${prefix} field a`)).not.toBe(normalizeErrorMessage(`${prefix} field b`));
  });

  it("stops at the configured count of distinct accounts", () => {
    expect(SAME_REQUEST_ERROR_STOP_AFTER).toBe(2);
    const tally = createSameRequestErrorTally();
    expect(tally.stopAfter).toBe(2);
    expect(tally.note("a", 400, "prompt is too long: 1")).toBe(false);
    // The same account again is still one account.
    expect(tally.note("a", 400, "prompt is too long: 2")).toBe(false);
    expect(tally.note("b", 422, "prompt is too long: 3")).toBe(false);
    expect(tally.note("b", 400, "prompt is too long: 4")).toBe(true);
    expect(createSameRequestErrorTally(0).note("a", 400, TOO_LONG)).toBe(false);
    expect(createSameRequestErrorTally(1).note("a", 400, TOO_LONG)).toBe(true);
  });
});

// Placeholder numbers and wording; each reads like a kind of error upstreams send.
describe("which errors count", () => {
  const counts = [
    [400, TOO_LONG],
    [400, "The model's maximum context length is 10000 tokens, but the messages came to 12345 tokens"],
    [400, "input plus `max_tokens` exceed context limit: 12345 + 100 > 10000"],
    [400, "Bad request: this request is over the model token limit (10000)"],
    [400, "Input tokens exceed this endpoint's limit of 10000"],
    [400, "the context window exceeds limit"],
    [400, "tools.0.input_schema: JSON schema is not valid"],
    [422, "tools[1]: function parameters schema rejected"],
    [400, "`thinking.budget_tokens` has to be lower than `max_tokens`"],
    [413, "Payload Too Large"],
    [413, ""],
  ];
  const ignored = [
    [400, "The workspace for this key has been disabled."],
    [400, "Your workspace must be verified to stream this model"],
    [400, "key limit exceeded for today"],
    [400, '{"error":{"code":"usage_limit_reached"}}'],
    [400, "insufficient quota"],
    [400, "rate limit exceeded"],
    [400, "invalid api key"],
    [400, "model example-model is not enabled for this key"],
    [400, "Missing scopes: chat.write"],
    [400, "Some other bad request"],
  ];

  it.each(counts)("counts a %i: %s", (status, message) => {
    expect(requestErrorSignature(status, `[${status}]: ${message}`)).not.toBeNull();
    expect(requestErrorSignature(status, `[${status}]: ${jsonBody(message, "req_placeholder_aaaa")}`)).not.toBeNull();
  });

  it.each(ignored)("doesn't count a %i: %s", (status, message) => {
    expect(requestErrorSignature(status, `[${status}]: ${message}`)).toBeNull();
  });

  it("doesn't count a request-shaped message whose body names a usage limit", () => {
    // Only isLimitError reads usage_limit_reached; the message alone would count.
    const body = JSON.stringify({ error: { message: TOO_LONG, code: "usage_limit_reached" } });
    expect(requestErrorSignature(400, `[400]: ${TOO_LONG}`)).not.toBeNull();
    expect(requestErrorSignature(400, `[400]: ${body}`)).toBeNull();
  });

  it("counts only 400, 413 and 422", () => {
    for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) expect(requestErrorSignature(status, `[${status}]: ${TOO_LONG}`)).toBeNull();
  });
});

describe("the same request error from two accounts", () => {
  it("stops after 2 of 5 keys and answers with the upstream's 400", async () => {
    const keys = await addKeys(5);
    upstream.script = Array(5).fill(failure(400, TOO_LONG));

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(`[400]: ${TOO_LONG}`);
    expect(warnings).toContain(stopLine("key-2"));
    // A custom endpoint locks no key for a request error, as before.
    for (const id of keys) expect(await lockEnd(id)).toBe(0);
  });

  it("counts the same message with different numbers as the same", async () => {
    const keys = await addKeys(5);
    upstream.script = [failure(400, TOO_LONG), failure(400, "prompt is too long: 12399 tokens > 10000 maximum")];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("[400]: prompt is too long: 12399 tokens > 10000 maximum");
  });

  it("stops on a JSON body with the same message and a different request id", async () => {
    const keys = await addKeys(5);
    upstream.script = [
      failure(400, jsonBody(TOO_LONG, "req_placeholder_aaaa")),
      failure(400, jsonBody(TOO_LONG, "req_placeholder_bbbb")),
      failure(400, jsonBody(TOO_LONG, "req_placeholder_cccc")),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
  });

  it("stops the same way on an Anthropic-compatible endpoint, answering with the upstream message", async () => {
    provider = `anthropic-compatible-gateway-${++providerSeq}`;
    const keys = await addKeys(5);
    upstream.script = [
      failure(400, jsonBody(TOO_LONG, "req_placeholder_aaaa")),
      failure(400, jsonBody(TOO_LONG, "req_placeholder_bbbb")),
      failure(400, jsonBody(TOO_LONG, "req_placeholder_cccc")),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(TOO_LONG);
    expect(await errorOf(res)).toContain("req_placeholder_bbbb");
    expect(warnings).toContain(stopLine("key-2"));
  });

  it("stops the same way on a 413 or a 422", async () => {
    for (const [status, message] of [[413, "payload rejected: 12345 bytes"], [422, "tools.0.input_schema: JSON schema is not valid"]]) {
      provider = `openai-compatible-gateway-${++providerSeq}`;
      upstream.calls = [];
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(status, message));

      const res = await chat();
      expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
      expect(res.status).toBe(status);
    }
  });

  it("keeps walking on an unknown 400, which may be about the account, and the next key serves the request", async () => {
    const keys = await addKeys(5);
    upstream.script = Array(2).fill(failure(400, "The workspace for this key has been disabled."));

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(200);
    expect(stopped()).toBe(false);
  });

  it("keeps walking when the keys give different messages", async () => {
    const keys = await addKeys(5);
    upstream.script = [
      failure(400, TOO_LONG),
      failure(400, "tools.0.input_schema: JSON schema is not valid"),
      failure(400, "`thinking.budget_tokens` has to be lower than `max_tokens`"),
      failure(400, "tools[1]: function parameters schema rejected"),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys));
    expect(res.status).toBe(200);
    expect(stopped()).toBe(false);
  });

  it("keeps the tally through a 429 between the two", async () => {
    const keys = await addKeys(5);
    upstream.script = [
      failure(400, TOO_LONG),
      failure(429, "rate limit exceeded"),
      failure(400, "prompt is too long: 12399 tokens > 10000 maximum"),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(400);
    expect(warnings).toContain(stopLine("key-3"));
  });

  for (const [label, message] of [
    ["names a rate limit", "rate limit exceeded"],
    ["reads like a quota (isLimitError)", "insufficient quota"],
    ["names a limit on the key", "key limit exceeded for today"],
    ["refuses the model for this key", "the model example-model is not enabled for this key"],
    ["is request-shaped but names a usage limit", JSON.stringify({ error: { message: TOO_LONG, code: "usage_limit_reached" } })],
  ]) {
    it(`keeps walking on a 400 that ${label}`, async () => {
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(400, message));

      await chat();
      expect(upstream.calls).toEqual(calls(keys));
      expect(stopped()).toBe(false);
    });
  }

  it("lets a combo move on to its next model", async () => {
    const keys = await addKeys(5);
    combos.set("big-combo", [`${provider}/${MODEL}`, `${provider}/${OTHER_MODEL}`]);
    upstream.script = Array(2).fill(failure(400, TOO_LONG));

    const res = await chat("big-combo");
    expect(res.status).toBe(200);
    expect(upstream.calls).toEqual([...calls(keys.slice(0, 2)), `${keys[0]}:${OTHER_MODEL}`]);
  });
});

describe("where the walk doesn't stop", () => {
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
      expect(stopped()).toBe(false);
    });
  }

  it("keeps the header-timeout cap of 2 keys", async () => {
    const keys = await addKeys(5);
    upstream.script = Array(5).fill(noHeaders);

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(504);
    expect(stopped()).toBe(false);
  });

  it("tries every key of a built-in provider", async () => {
    provider = `builtin-example-${++providerSeq}`;
    const keys = await addKeys(5);
    upstream.script = Array(5).fill(failure(400, TOO_LONG));

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys));
    expect(res.status).toBe(400);
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
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(400, TOO_LONG));

      const res = await chat(undefined, handleChatOff);
      expect(upstream.calls).toEqual(calls(keys));
      expect(res.status).toBe(400);
      expect(stopped()).toBe(false);
    });
  });
});
