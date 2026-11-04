// Cloudflare answers 524 when the origin sends no response headers for ~100-120s.
// A streaming request whose upstream is that slow to answer gets 200 + SSE
// headers early, keepalives while routing carries on, then the real stream or
// an in-band error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { respondWithEarlyHeaders, buildEarlyErrorBytes } from "../../open-sse/utils/earlyHeaders.js";
import { SSE_KEEPALIVE } from "../../open-sse/utils/sseConstants.js";
import { errorResponse } from "../../open-sse/utils/error.js";

const state = { settings: {}, accounts: [], core: null, coreCalls: [], markCalls: [] };

vi.mock("@/lib/localDb", () => ({ getSettings: async () => state.settings }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyLimitHold: async () => null }));
vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    extractApiKey: () => "sk-test",
    isValidApiKey: async () => true,
    getProviderCredentials: async (_provider, exclude) => state.accounts.find((a) => !exclude.has(a.connectionId)) ?? null,
    markAccountUnavailable: async (...args) => {
      state.markCalls.push(args);
      return { shouldFallback: true, cooldownMs: 1000 };
    },
    clearAccountError: async () => {},
  };
});
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => (m.includes("/") ? { provider: m.split("/")[0], model: m.split("/")[1] } : { provider: null, model: m }),
  getComboModels: async (name) => state.settings.combos?.[name] || null,
  comboLookupName: (name) => name,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: async () => {},
}));
vi.mock("open-sse/handlers/chatCore.js", async (importOriginal) => ({
  ...(await importOriginal()),
  handleChatCore: async (args) => {
    state.coreCalls.push(args);
    return state.core(args, state.coreCalls.length);
  },
}));

const { handleChat } = await import("@/sse/handlers/chat.js");

const enc = new TextEncoder();
const dec = new TextDecoder();
const DELAY = 30_000;
const KEEPALIVE = 15_000;

const SSE_HEADERS = { "Content-Type": "text/event-stream" };
const sse = (text) => new Response(enc.encode(text), { headers: SSE_HEADERS });
const ok = (text) => ({ success: true, response: sse(text) });
const fail = (status, error) => ({ success: false, status, error, response: errorResponse(status, error) });

// Resolves after `ms` of fake time, or at once with a 499 if the client signal aborts.
function later(ms, value, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(typeof value === "function" ? value() : value), ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(fail(499, "Request aborted")); }, { once: true });
  });
}

function read(res) {
  const reader = res.body.getReader();
  const out = { text: "", done: false, reader };
  out.pump = (async () => {
    while (true) {
      const r = await reader.read();
      if (r.done) { out.done = true; return; }
      out.text += dec.decode(r.value, { stream: true });
    }
  })().catch(() => { out.done = true; });
  return out;
}

const keepalives = (text) => text.split(SSE_KEEPALIVE).length - 1;

function request(path, body, opts) {
  return handleChat(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify(body),
  }), null, opts);
}

const claudeBody = { model: "slowp/m1", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] };
const openaiBody = { model: "slowp/m1", stream: true, messages: [{ role: "user", content: "hi" }] };
const CLAUDE_REPLY = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

beforeEach(() => {
  vi.useFakeTimers();
  state.settings = { requireApiKey: false, limitHoldEnabled: false };
  state.accounts = [
    { connectionId: "c1", connectionName: "acct1", accessToken: "t" },
    { connectionId: "c2", connectionName: "acct2", accessToken: "t" },
  ];
  state.coreCalls = [];
  state.markCalls = [];
});
afterEach(() => { vi.useRealTimers(); });

describe("respondWithEarlyHeaders", () => {
  it("delay 0 returns run's response untouched, whenever it comes", async () => {
    const real = new Response("x", { status: 503 });
    const p = respondWithEarlyHeaders({ run: () => later(120_000, real), sourceFormat: "claude", delayMs: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await p).toBe(real);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast answer keeps its own status and leaves no timer", async () => {
    const real = new Response("{}", { status: 429 });
    const p = respondWithEarlyHeaders({ run: () => later(5_000, real), sourceFormat: "claude", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBe(real);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a slow answer gets headers at the delay, keepalives, then the real stream", async () => {
    let resolved = false;
    const p = respondWithEarlyHeaders({ run: () => later(100_000, () => sse(CLAUDE_REPLY)), sourceFormat: "claude", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    p.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const out = read(res);
    await vi.advanceTimersByTimeAsync(0);
    expect(out.text).toBe(SSE_KEEPALIVE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(keepalives(out.text)).toBe(5);
    await vi.advanceTimersByTimeAsync(10_000);
    await out.pump;
    expect(out.text).toBe(SSE_KEEPALIVE.repeat(5) + CLAUDE_REPLY);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a client that leaves while waiting aborts run's signal and clears the timers", async () => {
    let signal;
    const p = respondWithEarlyHeaders({ run: (s) => { signal = s; return later(100_000, () => sse(CLAUDE_REPLY), s); }, sourceFormat: "openai", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(KEEPALIVE);
    expect(signal.aborted).toBe(false);
    await out.reader.cancel();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a reply that lands after the client left", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => new Response(body, { headers: SSE_HEADERS })), sourceFormat: "openai", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await out.reader.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a JSON reply after the headers is replayed as the client's stream", async () => {
    const message = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => Response.json(message)), sourceFormat: "claude", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(10_000);
    await out.pump;
    expect(out.text).toContain("event: message_start");
    expect(out.text).toContain("hello");
    expect(out.text).toContain("event: message_stop");
  });

  it("a thrown error after the headers ends the stream with a retryable error", async () => {
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => Promise.reject(new Error("boom"))), sourceFormat: "claude", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(10_000);
    await out.pump;
    expect(out.text).toContain('"type":"overloaded_error"');
    expect(out.text).toContain("boom");
  });
});

// The last event of each format, parsed.
function lastEvent(text) {
  const events = text.split("\n\n").filter((e) => e.trim() && !e.startsWith(":"));
  return events.map((e) => ({
    event: e.match(/^event: (.*)$/m)?.[1] || null,
    data: e.match(/^data: (.*)$/m)?.[1],
  }));
}

describe("in-band errors", () => {
  it("Claude: overloaded_error for retryable statuses, the status's own type otherwise", () => {
    for (const status of [429, 500, 502, 503, 504, 408]) {
      const [ev] = lastEvent(dec.decode(buildEarlyErrorBytes(status, "nope", "claude")));
      expect(ev.event).toBe("error");
      // Claude Code retries an error whose text carries "type":"overloaded_error".
      expect(ev.data).toContain('"type":"overloaded_error"');
      expect(JSON.parse(ev.data)).toEqual({ type: "error", error: { type: "overloaded_error", message: "nope" } });
    }
    const types = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 422: "api_error" };
    for (const [status, type] of Object.entries(types)) {
      const [ev] = lastEvent(dec.decode(buildEarlyErrorBytes(Number(status), "nope", "claude")));
      expect(JSON.parse(ev.data).error.type).toBe(type);
    }
  });

  it("OpenAI chat: a data error the SDKs throw on, then [DONE]", () => {
    const events = lastEvent(dec.decode(buildEarlyErrorBytes(503, "nope", "openai")));
    expect(JSON.parse(events[0].data)).toMatchObject({ error: { message: "nope", type: "server_error" } });
    expect(events[1].data).toBe("[DONE]");
  });

  it("Responses: response.failed, with codes Codex retries or gives up on", () => {
    const code = (status, opts) => JSON.parse(lastEvent(dec.decode(buildEarlyErrorBytes(status, "nope", "openai-responses", opts)))[0].data).response.error.code;
    const [ev] = lastEvent(dec.decode(buildEarlyErrorBytes(503, "nope", "openai-responses")));
    expect(ev.event).toBe("response.failed");
    expect(JSON.parse(ev.data)).toMatchObject({ type: "response.failed", response: { status: "failed", error: { message: "nope" } } });
    expect(code(503)).toBe("server_error");
    expect(code(429)).toBe("rate_limit_exceeded");
    expect(code(400)).toBe("invalid_prompt");
    expect(code(400, { retryable: false, exhausted: true })).toBe("insufficient_quota");
  });

  it("a final 'don't retry' routing error stays final in the stream", async () => {
    const final = new Response("limit reached, resets in 2h", { status: 400, headers: { "x-should-retry": "false" } });
    const p = respondWithEarlyHeaders({ run: () => later(40_000, final), sourceFormat: "openai-responses", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(10_000);
    await out.pump;
    const err = JSON.parse(lastEvent(out.text)[0].data).response.error;
    expect(err).toEqual({ code: "insufficient_quota", message: "limit reached, resets in 2h" });
  });
});

describe("handleChat with early headers", () => {
  it("off for routes that don't ask for it: the slow failure keeps its status", async () => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const p = request("/v1/messages", claudeBody);
    await vi.advanceTimersByTimeAsync(80_000);
    expect((await p).status).toBe(503);
  });

  it("a fast failure keeps its real HTTP status", async () => {
    state.core = () => fail(503, "overloaded");
    const res = await request("/v1/messages", claudeBody, { earlyHeaders: true });
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(state.coreCalls).toHaveLength(2);
  });

  it("a non-stream request is never committed early", async () => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const p = request("/v1/messages", { ...claudeBody, stream: false }, { earlyHeaders: true });
    await vi.advanceTimersByTimeAsync(80_000);
    expect((await p).status).toBe(503);
  });

  it("slow first account, next account answers: one 200 stream, the first account still locked", async () => {
    state.core = (args, n) => (n === 1 ? later(40_000, fail(503, "slow then overloaded"), args.clientSignal) : later(20_000, () => ok(CLAUDE_REPLY), args.clientSignal));
    const p = request("/v1/messages", claudeBody, { earlyHeaders: true });
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const out = read(res);
    await vi.advanceTimersByTimeAsync(40_000);
    await out.pump;
    expect(out.text.startsWith(SSE_KEEPALIVE)).toBe(true);
    expect(keepalives(out.text)).toBeGreaterThanOrEqual(3);
    expect(out.text.endsWith(CLAUDE_REPLY)).toBe(true);
    expect(state.coreCalls.map((c) => c.connectionId)).toEqual(["c1", "c2"]);
    expect(state.markCalls.map((c) => c[0])).toEqual(["c1"]);
  });

  it("slow first combo model, second answers", async () => {
    state.settings.combos = { duo: ["slowp/m1", "fastp/m2"] };
    state.core = (args) => (args.modelInfo.provider === "slowp"
      ? later(40_000, fail(503, "overloaded"), args.clientSignal)
      : later(5_000, () => ok('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'), args.clientSignal));
    const p = request("/v1/chat/completions", { ...openaiBody, model: "duo" }, { earlyHeaders: true });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(200_000);
    await out.pump;
    expect(out.text).toContain('"content":"hi"');
    expect(out.text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(state.coreCalls.some((c) => c.modelInfo.provider === "fastp")).toBe(true);
  });

  it.each([
    ["/v1/messages", claudeBody, (t) => expect(t).toMatch(/event: error\ndata: \{"type":"error","error":\{"type":"overloaded_error"/)],
    ["/v1/chat/completions", openaiBody, (t) => { expect(t).toMatch(/data: \{"error":\{"message":"[^"]*overloaded/); expect(t.endsWith("data: [DONE]\n\n")).toBe(true); }],
    ["/v1/responses", { model: "slowp/m1", stream: true, input: "hi" }, (t) => expect(t).toMatch(/event: response\.failed\ndata: \{"type":"response\.failed".*"code":"server_error"/)],
  ])("slow and every account fails: in-band error on %s", async (path, body, check) => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const p = request(path, body, { earlyHeaders: true });
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    expect(res.status).toBe(200);
    const out = read(res);
    await vi.advanceTimersByTimeAsync(60_000);
    await out.pump;
    check(out.text);
    expect(state.coreCalls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("client leaves while waiting: upstream aborted, no other account tried or locked", async () => {
    state.core = (args) => later(100_000, () => ok(CLAUDE_REPLY), args.clientSignal);
    const p = request("/v1/messages", claudeBody, { earlyHeaders: true });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(KEEPALIVE);
    await out.reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.coreCalls).toHaveLength(1);
    expect(state.coreCalls[0].clientSignal.aborted).toBe(true);
    expect(state.markCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("STREAM_EARLY_HEADERS_MS", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const load = async (value) => {
    if (value !== undefined) vi.stubEnv("STREAM_EARLY_HEADERS_MS", value);
    vi.resetModules();
    return (await import("../../open-sse/config/runtimeConfig.js")).STREAM_EARLY_HEADERS_MS;
  };

  it("defaults to 30s, accepts 0 to turn it off, ignores junk", async () => {
    expect(await load()).toBe(30_000);
    expect(await load("0")).toBe(0);
    expect(await load("20000")).toBe(20_000);
    expect(await load("-5")).toBe(30_000);
    expect(await load("soon")).toBe(30_000);
    expect(await load(String(2 ** 31))).toBe(30_000);
  });
});
