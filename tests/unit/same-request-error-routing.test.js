// On a custom endpoint, a request every key refuses the same way (a prompt
// longer than the model's context window, a tool schema the upstream rejects)
// stops the account walk once enough keys gave the same request-shaped error,
// instead of costing one upstream call per key before failing with that error
// anyway. Request-shaped means a 413, or a 400/422 matching
// SAME_REQUEST_ERROR_PATTERNS, and in both cases no veto (key, billing, limit,
// plan or organization wording). When the keys all reach one upstream, two
// keys' messages match up to numbers. When they don't, two distinct upstreams
// must give the very same message with a number in it (never a 413). Any other
// error and built-in providers keep walking.
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
const { normalizeErrorMessage, upstreamMessage, requestErrorSignature, createSameRequestErrorTally } = await import("open-sse/services/sameRequestError.js");
const { SAME_REQUEST_ERROR_PATTERNS, SAME_REQUEST_ERROR_KEY_LIMIT, MODEL_REFUSAL, OPERATION_REFUSAL } = await import("open-sse/config/errorConfig.js");
const { namesAccountOrLimit } = await import("open-sse/services/accountFallback.js");
const { isLimitError } = await import("open-sse/utils/limitHold.js");
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
    expect(tally.note("a", "up-a", 400, "prompt is too long: 1")).toBeNull();
    // The same account again is still one account.
    expect(tally.note("a", "up-a", 400, "prompt is too long: 2")).toBeNull();
    expect(tally.note("b", "up-b", 422, "prompt is too long: 3")).toBeNull();
    // Same up to numbers: enough for keys on one upstream only.
    expect(tally.note("b", "up-b", 400, "prompt is too long: 4")).toBe("normalized");
    // The very same message from a second upstream, case, spacing at the ends
    // and a relay's request id aside.
    expect(tally.note("c", "up-c", 400, " Prompt is too long: 1 (request id: 2026aaa)")).toBe("exact");
    expect(createSameRequestErrorTally(0).note("a", "up-a", 400, TOO_LONG)).toBeNull();
  });

  it("counts upstreams, not keys, on the exact path", () => {
    const tally = createSameRequestErrorTally();
    expect(tally.note("a", "up-a", 400, TOO_LONG)).toBeNull();
    // A second key on the same upstream: agreement up to numbers only.
    expect(tally.note("b", "up-a", 400, TOO_LONG)).toBe("normalized");
    expect(tally.note("c", "up-b", 400, TOO_LONG)).toBe("exact");
  });

  it("never agrees exactly on a 413 or a message with no number", () => {
    for (const [status, message] of [[413, "Payload Too Large"], [413, "request body too large: 12345 bytes"], [400, "Input is too long for the model."]]) {
      const tally = createSameRequestErrorTally();
      tally.note("a", "up-a", status, message);
      expect(tally.note("b", "up-b", status, message)).toBe("normalized");
      expect(tally.note("c", "up-c", status, message)).toBe("normalized");
    }
  });

  it("needs two upstreams to agree exactly even with a stop after 1", () => {
    const tally = createSameRequestErrorTally(1);
    // One key is enough on one upstream...
    expect(tally.note("a", "up-a", 400, TOO_LONG)).toBe("normalized");
    // ...but agreement across servers needs a second one.
    expect(tally.note("b", "up-b", 400, TOO_LONG)).toBe("exact");
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
    // A tool or property name that merely contains a veto word.
    [400, "Invalid schema for function 'cancel_subscription': additionalProperties has to be false"],
    [422, "tools.0.input_schema: property 'subscriptionId' is not valid"],
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
    [400, "You have reached your daily token limit for this key"],
    [400, "Tokens per day limit exceeded for this endpoint"],
    [400, "Request too large for example-model in organization org-example: tokens per min limit 10000, requested 12345."],
    [400, "Too many tokens right now, please wait and retry"],
    [400, "Request took too long to process"],
    [413, "tokens_limit_reached: request body too large for example-model, max size 8000 tokens"],
  ];

  it.each(counts)("counts a %i: %s", (status, message) => {
    expect(requestErrorSignature(status, `[${status}]: ${message}`)).not.toBeNull();
    expect(requestErrorSignature(status, `[${status}]: ${jsonBody(message, "req_placeholder_aaaa")}`)).not.toBeNull();
  });

  it.each(ignored)("doesn't count a %i: %s", (status, message) => {
    expect(requestErrorSignature(status, `[${status}]: ${message}`)).toBeNull();
  });

  it("pins every allowlist pattern with a message only it matches", () => {
    const pinned = [
      "The model's maximum context length is 10000 tokens, but the messages came to 12345 tokens",
      "the context window exceeds limit",
      "input plus `max_tokens` exceed context limit: 12345 + 100 > 10000",
      "Bad request: this request is over the model token limit (10000)",
      "Input tokens exceed this endpoint's limit of 10000",
      TOO_LONG,
      "tools.0.input_schema: JSON schema is not valid",
      "`thinking.budget_tokens` has to be lower than `max_tokens`",
    ];
    const covered = new Set();
    for (const message of pinned) {
      const matching = SAME_REQUEST_ERROR_PATTERNS.filter((p) => p.test(message));
      expect(matching, message).toHaveLength(1);
      covered.add(matching[0]);
      expect(requestErrorSignature(400, `[400]: ${message}`), message).not.toBeNull();
    }
    expect(covered.size).toBe(SAME_REQUEST_ERROR_PATTERNS.length);
  });

  // Each message holds the words of one alternative inside a pattern and no
  // other, so dropping that alternative from the pattern turns its case red.
  it.each([
    ["input_schema", "tools: input_schema rejected"],
    ["json schema", "the JSON schema for the function is not valid"],
    ["invalid schema", "invalid schema for a tool"],
    ["function parameters", "function parameters must be an object"],
    ["tools.N", "tools.2.name: required"],
    ["tools[N]", "tools[2].name: required"],
    ["model ... token limit", "Bad request: this request is over the model token limit (10000)"],
    ["token limit ... context", "token limit of the context reached: 12345 > 10000"],
  ])("counts a message only the %s alternative matches: %s", (_alt, message) => {
    const alternatives = [/input_schema/i, /json schema/i, /invalid schema/i, /function parameters/i, /\btools?\.\d+/i, /\btools?\[\d+\]/i,
      /\b(?:model|context)\b.{0,30}\btoken limit\b/i, /\btoken limit\b.{0,30}\b(?:model|context)\b/i];
    expect(alternatives.filter((a) => a.test(message))).toHaveLength(1);
    expect(requestErrorSignature(400, `[400]: ${message}`)).not.toBeNull();
  });

  it("drops a relay's request id from the message", () => {
    const a = `[400]: ${TOO_LONG} (request id: 20261115120000123456789abcDEF12)`;
    const b = `[400]: ${TOO_LONG} (Request ID: 20261115120005987654321xyzUVW98)`;
    expect(upstreamMessage(a)).toBe(TOO_LONG);
    expect(requestErrorSignature(400, a)).toBe(requestErrorSignature(400, b));
    expect(upstreamMessage(`[400]: ${jsonBody(`${TOO_LONG} (request id: 2026111512000000aaa)`, "req_placeholder_aaaa")}`)).toBe(TOO_LONG);
  });

  it("drops a relay's request id from a body that is a JSON string", () => {
    const a = `[400]: ${JSON.stringify(`${TOO_LONG} (request id: 20261115120000123456789abcDEF12)`)}`;
    const b = `[400]: ${JSON.stringify(`${TOO_LONG} (request id: 20261115120005987654321xyzUVW98)`)}`;
    expect(upstreamMessage(a)).toBe(JSON.stringify(TOO_LONG));
    expect(requestErrorSignature(400, a)).not.toBeNull();
    expect(requestErrorSignature(400, a)).toBe(requestErrorSignature(400, b));
  });

  // Bodies are read up to SAME_REQUEST_ERROR_MAX_TEXT (64 KiB) and matched
  // synchronously, so no pattern may backtrack badly on a long run.
  describe("stays fast on a 64 KiB body", () => {
    const n = 65536;
    const runs = [" ", "a", "0", "(", "input ", "request ", "model ", "context ", "exceed ", "token limit ", "tools.", "per ", "your ",
      "(request id: ", "(request id: 1"].map((unit) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n));
    const timed = (fn) => { const start = performance.now(); fn(); return performance.now() - start; };

    it("finishes requestErrorSignature on a message with 64K trailing spaces", () => {
      expect(timed(() => requestErrorSignature(400, `[400]: ${TOO_LONG}${" ".repeat(n)}`))).toBeLessThan(200);
    });

    it("finishes requestErrorSignature on a 422 JSON body echoing 64K spaces of input", () => {
      const body = JSON.stringify({ detail: [{ msg: TOO_LONG, input: " ".repeat(n) }], message: TOO_LONG });
      expect(timed(() => requestErrorSignature(422, `[422]: ${body}`))).toBeLessThan(200);
    });

    it.each(runs.map((run) => [JSON.stringify(run.slice(0, 16)), run]))("runs every pattern and veto on %s... in time", (_label, run) => {
      const regexes = [...SAME_REQUEST_ERROR_PATTERNS, SAME_REQUEST_ERROR_KEY_LIMIT, MODEL_REFUSAL, OPERATION_REFUSAL];
      for (const re of regexes) expect(timed(() => re.test(run)), String(re)).toBeLessThan(200);
      expect(timed(() => requestErrorSignature(400, `[400]: ${TOO_LONG} ${run}`))).toBeLessThan(200);
      expect(timed(() => upstreamMessage(run))).toBeLessThan(200);
    });
  });

  // Each message is request-shaped, and exactly one veto keeps it out.
  const vetoes = {
    namesAccountOrLimit: (text) => namesAccountOrLimit(text),
    isLimitError: (text) => isLimitError(400, text),
    MODEL_REFUSAL: (text) => MODEL_REFUSAL.test(text.toLowerCase()),
    OPERATION_REFUSAL: (text) => OPERATION_REFUSAL.test(text.toLowerCase()),
    SAME_REQUEST_ERROR_KEY_LIMIT: (text) => SAME_REQUEST_ERROR_KEY_LIMIT.test(text),
  };
  it.each([
    ["namesAccountOrLimit", `${TOO_LONG} (invalid api key)`],
    ["isLimitError", JSON.stringify({ error: { message: TOO_LONG, code: "usage_limit_reached" } })],
    ["MODEL_REFUSAL", `${TOO_LONG}; model example-model is not available on this endpoint`],
    ["OPERATION_REFUSAL", `${TOO_LONG}; permission denied for this operation`],
    ...["per minute", "per hour", "per day", "per month", "tpm", "tpd", "rpm", "rpd", "daily", "monthly", "in organization org-example",
      "for this key", "for this account", "throttled", "please wait", "tier 1", "upgrade", "your plan", "tokens_limit_reached",
      "your organization", "this organisation", "the organization", "your subscription", "this subscription", "the subscription"]
      .map((words) => ["SAME_REQUEST_ERROR_KEY_LIMIT", `${TOO_LONG} (${words})`]),
    // A hosted tool is enabled per organization.
    ["SAME_REQUEST_ERROR_KEY_LIMIT", "tools.0: web search is not enabled for your organization"],
    ["SAME_REQUEST_ERROR_KEY_LIMIT", "tools[0].type: web_search isn't available for this organization"],
  ])("only %s keeps out: %s", (veto, body) => {
    const raw = `[400]: ${body}`;
    expect(SAME_REQUEST_ERROR_PATTERNS.some((p) => p.test(upstreamMessage(raw)))).toBe(true);
    expect(Object.keys(vetoes).filter((name) => vetoes[name](raw))).toEqual([veto]);
    expect(requestErrorSignature(400, raw)).toBeNull();
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

  // Not request-shaped, so the allowlist leaves them out.
  for (const message of [
    "rate limit exceeded",
    "insufficient quota",
    "key limit exceeded for today",
    "the model example-model is not enabled for this key",
  ]) {
    it(`keeps walking on a 400 the allowlist doesn't match: ${message}`, async () => {
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(400, message));

      await chat();
      expect(upstream.calls).toEqual(calls(keys));
      expect(stopped()).toBe(false);
    });
  }

  // Request-shaped, but a veto says it's about the key.
  for (const [status, message] of [
    [400, JSON.stringify({ error: { message: TOO_LONG, code: "usage_limit_reached" } })],
    [400, "Request too large for example-model in organization org-example: tokens per min limit 10000, requested 12345."],
    [413, "tokens_limit_reached: request body too large for example-model, max size 8000 tokens"],
  ]) {
    it(`keeps walking on a ${status} a veto keeps out: ${message}`, async () => {
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(status, message));

      await chat();
      expect(upstream.calls).toEqual(calls(keys));
      expect(stopped()).toBe(false);
    });
  }

  // Two keys whose limits differ: the same message up to numbers.
  const smallWindow = "prompt is too long: 12345 tokens > 10000 maximum";
  const otherWindow = "prompt is too long: 12345 tokens > 11000 maximum";
  const apart = { 1: { baseUrl: "http://upstream-a.example/v1", ownBaseUrl: true }, 2: { baseUrl: "http://upstream-b.example/v1", ownBaseUrl: true },
    3: { baseUrl: "http://upstream-c.example/v1", ownBaseUrl: true }, 4: { baseUrl: "http://upstream-d.example/v1", ownBaseUrl: true },
    5: { baseUrl: "http://upstream-e.example/v1", ownBaseUrl: true } };

  it("keeps walking on keys of other upstreams whose messages differ in numbers, and the next key serves", async () => {
    const keys = await addKeys(5, apart);
    upstream.script = [failure(400, smallWindow), failure(400, otherWindow)];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(200);
    expect(stopped()).toBe(false);
  });

  it("stops on keys of other upstreams once 2 gave the very same message", async () => {
    const keys = await addKeys(5, apart);
    upstream.script = [
      failure(400, `${TOO_LONG} (request id: 20261115120000111aaa)`),
      failure(400, `${TOO_LONG.toUpperCase()} (request id: 20261115120000222bbb)`),
      failure(400, TOO_LONG),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
    expect(warnings).toContain(stopLine("key-2"));
  });

  it("stops on keys of other upstreams at the second upstream that gives the very same message", async () => {
    const keys = await addKeys(5, apart);
    upstream.script = [failure(400, smallWindow), failure(400, otherWindow), failure(400, otherWindow)];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(400);
    expect(warnings).toContain(stopLine("key-3"));
  });

  it("keeps walking when the two agreeing keys share one upstream and a third key is elsewhere", async () => {
    const nodeUrl = { baseUrl: "http://upstream-a.example/v1" };
    const keys = await addKeys(5, { 1: nodeUrl, 2: nodeUrl, 3: { baseUrl: "http://upstream-b.example/v1", ownBaseUrl: true }, 4: nodeUrl, 5: nodeUrl });
    upstream.script = Array(2).fill(failure(400, TOO_LONG));

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(200);
    expect(stopped()).toBe(false);
  });

  for (const [label, status, message] of [
    ["a 400 with no number in it", 400, "Input is too long for the model."],
    ["a 413", 413, "payload rejected: 12345 bytes"],
  ]) {
    it(`keeps walking on keys of other upstreams on the same ${label}`, async () => {
      const keys = await addKeys(5, apart);
      upstream.script = Array(5).fill(failure(status, message));

      await chat();
      expect(upstream.calls).toEqual(calls(keys));
      expect(stopped()).toBe(false);
    });
  }

  it("still lets a veto win on keys of other upstreams", async () => {
    const keys = await addKeys(5, apart);
    upstream.script = Array(5).fill(failure(400, `${TOO_LONG} (tokens per min)`));

    await chat();
    expect(upstream.calls).toEqual(calls(keys));
    expect(stopped()).toBe(false);
  });

  it("compares up to numbers again once no key has its own base URL", async () => {
    const keys = await addKeys(5);
    upstream.script = [failure(400, smallWindow), failure(400, otherWindow)];

    await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
  });

  it("compares exactly when a key has its own base URL, even with the same URL", async () => {
    // Same URL on every key: only the ownBaseUrl flag makes this an exact compare.
    const same = { baseUrl: "http://upstream-a.example/v1" };
    const keys = await addKeys(5, { 1: same, 2: same, 3: { ...same, ownBaseUrl: true }, 4: same, 5: same });
    upstream.script = [failure(400, smallWindow), failure(400, otherWindow)];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(200);
    expect(stopped()).toBe(false);
  });

  it("compares exactly when the keys' base URLs differ", async () => {
    const keys = await addKeys(5, { 1: { baseUrl: "http://upstream-a.example/v1" }, 2: { baseUrl: "http://upstream-a.example/v1" }, 3: { baseUrl: "http://upstream-b.example/v1" } });
    upstream.script = [failure(400, smallWindow), failure(400, otherWindow)];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
    expect(res.status).toBe(200);
  });

  it("compares up to numbers when every key has the same base URL", async () => {
    const same = { baseUrl: "http://upstream-a.example/v1" };
    const keys = await addKeys(5, { 1: same, 2: same, 3: same, 4: same, 5: same });
    upstream.script = [failure(400, smallWindow), failure(400, otherWindow)];

    await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
  });

  it("ignores an inactive key on another server", async () => {
    const keys = await addKeys(5);
    await db.createProviderConnection({
      provider, authType: "apikey", name: "key-off", apiKey: "placeholder-off", priority: 9, isActive: false,
      providerSpecificData: { baseUrl: "http://upstream-b.example/v1", ownBaseUrl: true },
    });
    upstream.script = [failure(400, smallWindow), failure(400, otherWindow)];

    await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
  });

  it("stops when the messages differ only in a relay's request id", async () => {
    const keys = await addKeys(5);
    upstream.script = [
      failure(400, `${TOO_LONG} (request id: 20261115120000123456789abcDEF12)`),
      failure(400, `${TOO_LONG} (request id: 20261115120005987654321xyzUVW98)`),
      failure(400, `${TOO_LONG} (request id: 20261115120009555555555qrsTUV55)`),
    ];

    const res = await chat();
    expect(upstream.calls).toEqual(calls(keys.slice(0, 2)));
    expect(res.status).toBe(400);
  });

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

  describe("with SAME_REQUEST_ERROR_STOP_AFTER=1", () => {
    let handleChatOne;
    beforeAll(async () => {
      vi.stubEnv("SAME_REQUEST_ERROR_STOP_AFTER", "1");
      vi.resetModules();
      ({ handleChat: handleChatOne } = await import("@/sse/handlers/chat.js"));
    });
    afterAll(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("stops at the first such error when the keys share one upstream", async () => {
      const keys = await addKeys(5);
      upstream.script = Array(5).fill(failure(400, TOO_LONG));

      const res = await chat(undefined, handleChatOne);
      expect(upstream.calls).toEqual(calls(keys.slice(0, 1)));
      expect(res.status).toBe(400);
    });

    it("walks keys of other upstreams until two of them give the very same message", async () => {
      const own = (n) => ({ baseUrl: `http://upstream-${n}.example/v1`, ownBaseUrl: true });
      const keys = await addKeys(5, { 1: own(1), 2: own(2), 3: own(3), 4: own(4), 5: own(5) });
      upstream.script = [
        failure(400, "prompt is too long: 12345 tokens > 11000 maximum"),
        failure(400, TOO_LONG),
        failure(400, TOO_LONG),
      ];

      const res = await chat(undefined, handleChatOne);
      expect(upstream.calls).toEqual(calls(keys.slice(0, 3)));
      expect(res.status).toBe(400);
    });
  });
});
