// Cloudflare answers 524 when the origin sends no response headers for ~100-120s.
// A streaming request whose upstream is that slow to answer gets 200 + SSE
// headers early, keepalives while routing carries on, then the real stream or
// an in-band error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { respondWithEarlyHeaders, buildEarlyErrorBytes } from "../../open-sse/utils/earlyHeaders.js";
import { SSE_KEEPALIVE } from "../../open-sse/utils/sseConstants.js";
import { errorResponse } from "../../open-sse/utils/error.js";
import { createLimitHoldResponse } from "../../open-sse/utils/limitHold.js";

const state = { settings: {}, accounts: [], exhausted: null, creds: null, core: null, coreCalls: [], markCalls: [], modelLookups: [] };

vi.mock("@/lib/localDb", () => ({ getSettings: async () => state.settings }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyLimitHold: async () => null }));
vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    extractApiKey: () => "sk-test",
    isValidApiKey: async () => true,
    getProviderCredentials: async (provider, exclude) => state.creds?.(provider, exclude)
      ?? state.accounts.find((a) => !exclude.has(a.connectionId)) ?? state.exhausted ?? null,
    markAccountUnavailable: async (...args) => {
      state.markCalls.push(args);
      return { shouldFallback: true, cooldownMs: 1000 };
    },
    clearAccountError: async () => {},
  };
});
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async (m) => {
    state.modelLookups.push(m);
    return m.includes("/") ? { provider: m.split("/")[0], model: m.split("/")[1] } : { provider: null, model: m };
  },
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

function request(path, body, opts, { headers = {}, signal } = {}) {
  return handleChat(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test", ...headers },
    body: JSON.stringify(body),
    signal,
  }), null, opts);
}

// Run the helper past its delay and read everything it writes.
async function earlyRun(run, sourceFormat, settleMs = 10_000) {
  const p = respondWithEarlyHeaders({ run, sourceFormat, delayMs: DELAY, keepaliveMs: KEEPALIVE });
  await vi.advanceTimersByTimeAsync(DELAY);
  const res = await p;
  expect(res.status).toBe(200);
  const out = read(res);
  await vi.advanceTimersByTimeAsync(settleMs);
  await out.pump;
  return out.text;
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
  state.exhausted = null;
  state.creds = null;
  state.coreCalls = [];
  state.markCalls = [];
  state.modelLookups = [];
});
afterEach(() => { vi.useRealTimers(); });

// Every event of an SSE text, parsed (comments skipped).
function events(text) {
  return text.split("\n\n").filter((e) => e.trim() && !e.startsWith(":")).map((e) => ({
    event: e.match(/^event: (.*)$/m)?.[1] || null,
    data: e.match(/^data: (.*)$/m)?.[1],
  }));
}
const errorOf = (bytes) => JSON.parse(events(dec.decode(bytes))[0].data);

describe("respondWithEarlyHeaders", () => {
  it("delay 0 returns run's response untouched, whenever it comes", async () => {
    const real = new Response("x", { status: 503 });
    const p = respondWithEarlyHeaders({ run: () => later(120_000, real), sourceFormat: "claude", delayMs: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await p).toBe(real);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("STREAM_KEEPALIVE_MS=0 turns it off too", async () => {
    const real = new Response("x", { status: 503 });
    const p = respondWithEarlyHeaders({ run: () => later(120_000, real), sourceFormat: "claude", delayMs: DELAY, keepaliveMs: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await p).toBe(real);
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

  it("the request's own signal aborts run's signal before the headers go out", async () => {
    const client = new AbortController();
    let signal;
    const p = respondWithEarlyHeaders({ run: (s) => { signal = s; return later(100_000, () => sse(CLAUDE_REPLY), s); }, sourceFormat: "claude", signal: client.signal, delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(10_000);
    client.abort();
    expect(signal.aborted).toBe(true);
    expect((await p).status).toBe(499);
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

  it.each([
    ["JSON", () => Response.json({ id: "x", object: "unknown" })],
    ["plain text", () => new Response("hello", { headers: { "Content-Type": "text/plain" } })],
  ])("a 200 %s reply after the headers ends with an in-band 502", async (_name, reply) => {
    const text = await earlyRun(() => later(40_000, reply), "claude");
    const [ev] = events(text);
    expect(ev.event).toBe("error");
    expect(JSON.parse(ev.data).error).toMatchObject({ type: "overloaded_error", code: "bad_gateway" });
  });

  it("a stream that errors without its own terminal ends with an in-band error", async () => {
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; } });
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => new Response(body, { headers: SSE_HEADERS })), sourceFormat: "openai", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(10_000);
    ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
    await vi.advanceTimersByTimeAsync(0);
    ctrl.error(new Error("upstream reset"));
    await out.pump;
    expect(out.text).toContain('"content":"hi"');
    const evs = events(out.text);
    expect(JSON.parse(evs.at(-2).data).error).toMatchObject({ type: "server_error", code: "bad_gateway" });
    expect(evs.at(-1).data).toBe("[DONE]");
  });

  it("a thrown error ends the stream with a generic retryable error and logs the detail", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => Promise.reject(new Error("secret internals"))), sourceFormat: "claude", delayMs: DELAY, keepaliveMs: KEEPALIVE, log });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(10_000);
    await out.pump;
    expect(out.text).toContain('"type":"overloaded_error"');
    expect(out.text).toContain("Internal server error");
    expect(out.text).not.toContain("secret internals");
    expect(log.error.mock.calls[0][1]).toContain("secret internals");
  });
});

describe("in-band errors", () => {
  it("Claude: overloaded_error for retryable statuses, the status's own type otherwise", () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      const [ev] = events(dec.decode(buildEarlyErrorBytes(status, "nope", "claude")));
      expect(ev.event).toBe("error");
      // Claude Code retries an error whose text carries "type":"overloaded_error".
      expect(ev.data).toContain('"type":"overloaded_error"');
      expect(JSON.parse(ev.data)).toMatchObject({ type: "error", error: { type: "overloaded_error", message: "nope" } });
    }
    const types = { 400: "invalid_request_error", 401: "authentication_error", 402: "billing_error", 403: "permission_error", 404: "invalid_request_error", 413: "invalid_request_error" };
    for (const [status, type] of Object.entries(types)) {
      expect(errorOf(buildEarlyErrorBytes(Number(status), "nope", "claude")).error.type).toBe(type);
    }
  });

  it("OpenAI chat: a data error the SDKs throw on, then [DONE]", () => {
    const evs = events(dec.decode(buildEarlyErrorBytes(503, "nope", "openai")));
    expect(JSON.parse(evs[0].data)).toMatchObject({ error: { message: "nope", type: "server_error" } });
    expect(evs[1].data).toBe("[DONE]");
    expect(errorOf(buildEarlyErrorBytes(429, "slow down", "openai")).error).toMatchObject({ type: "rate_limit_error", code: "rate_limit_exceeded" });
    expect(errorOf(buildEarlyErrorBytes(400, "bad", "openai")).error).toMatchObject({ type: "invalid_request_error", code: "bad_request" });
  });

  it("Responses: response.failed, with codes Codex retries or gives up on", () => {
    const code = (status, opts) => errorOf(buildEarlyErrorBytes(status, "nope", "openai-responses", opts)).response.error.code;
    const [ev] = events(dec.decode(buildEarlyErrorBytes(503, "nope", "openai-responses")));
    expect(ev.event).toBe("response.failed");
    expect(JSON.parse(ev.data)).toMatchObject({ type: "response.failed", response: { status: "failed", error: { message: "nope" } } });
    expect(code(503)).toBe("server_error");
    expect(code(409)).toBe("server_error");
    expect(code(429)).toBe("rate_limit_exceeded");
    expect(code(400)).toBe("invalid_prompt");
    expect(code(400, { retryable: false })).toBe("invalid_prompt");
  });

  it("a failed body's message reaches the Responses error; its code comes from the status", async () => {
    const body = Response.json({ error: { message: "too long", code: "bad_request" } }, { status: 400 });
    const text = await earlyRun(() => later(40_000, body), "openai-responses");
    expect(JSON.parse(events(text)[0].data).response.error).toEqual({ type: "stream_error", code: "invalid_prompt", message: "too long" });
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

  it("a format without keepalives on /v1/chat/completions is never committed early", async () => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const gemini = { model: "slowp/m1", stream: true, contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    const p = request("/v1/chat/completions", gemini, { earlyHeaders: true });
    await vi.advanceTimersByTimeAsync(80_000);
    expect((await p).status).toBe(503);
    expect(state.coreCalls[0].body.contents).toBeDefined();
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
    ["/v1/messages", claudeBody, (t) => expect(t).toMatch(/event: error\ndata: \{"type":"error","error":\{"message":"[^"]*overloaded[^"]*","type":"overloaded_error"/)],
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

  it("Codex, every account out of quota: final response.failed that keeps the reset countdown", async () => {
    state.accounts = [{ connectionId: "c1", connectionName: "acct1", accessToken: "t" }];
    state.exhausted = {
      allRateLimited: true,
      allLimitsExhausted: true,
      providerResetAtMs: Date.now() + 2 * 3_600_000 + 60_000,
      retryAfter: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      retryAfterHuman: "reset after 2h",
      lastError: "usage_limit_reached",
      lastErrorCode: 429,
    };
    state.core = (args) => later(40_000, fail(429, "usage_limit_reached"), args.clientSignal);
    const p = request("/v1/responses", { model: "slowp/m1", stream: true, input: "hi" }, { earlyHeaders: true }, { headers: { "user-agent": "codex-tui/0.166.0" } });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(20_000);
    await out.pump;
    const err = JSON.parse(events(out.text)[0].data).response.error;
    // Codex shows invalid_prompt's message as is and doesn't retry it.
    expect(err.code).toBe("invalid_prompt");
    expect(err.message).toMatch(/^All your accounts have hit their limits\. Next account resets in 2 hours/);
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

  it("client leaves before the headers go out: same, through the request's signal", async () => {
    const client = new AbortController();
    state.core = (args) => later(100_000, () => ok(CLAUDE_REPLY), args.clientSignal);
    const p = request("/v1/messages", claudeBody, { earlyHeaders: true }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    client.abort();
    const res = await p;
    expect(res.status).toBe(499);
    expect(state.coreCalls).toHaveLength(1);
    expect(state.coreCalls[0].clientSignal.aborted).toBe(true);
    expect(state.markCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("client leaves mid-combo: later models are never called", async () => {
    const client = new AbortController();
    state.settings.combos = { trio: ["slowp/a", "nextp/b", "lastp/c"] };
    state.core = (args) => later(100_000, () => ok(CLAUDE_REPLY), args.clientSignal);
    const p = request("/v1/messages", { ...claudeBody, model: "trio" }, { earlyHeaders: true }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    client.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(state.coreCalls.map((c) => c.modelInfo.provider)).toEqual(["slowp"]);
    // Not even looked up: no search enrichment or account pick for them.
    expect(state.modelLookups.filter((m) => m === "nextp/b" || m === "lastp/c")).toEqual([]);
    expect(state.markCalls).toHaveLength(0);
  });

  // Every account limited, but the client left meanwhile: nothing to wait for.
  const limitedAfterHangUp = (client, provider = null) => (p) => {
    if (provider && p !== provider) return null;
    client.abort();
    return {
      allRateLimited: true,
      allLimitsExhausted: true,
      retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
      retryAfterHuman: "reset after 1h",
      lastError: "usage_limit_reached",
      lastErrorCode: 429,
    };
  };

  it("no limit hold for a client that hung up", async () => {
    state.settings.limitHoldEnabled = true;
    const client = new AbortController();
    state.creds = limitedAfterHangUp(client);
    const p = request("/v1/messages", claudeBody, { earlyHeaders: true }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).not.toContain("text/event-stream");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no combo limit hold when the client hung up between models", async () => {
    state.settings.limitHoldEnabled = true;
    state.settings.combos = { duo: ["slowp/a", "nextp/b"] };
    const client = new AbortController();
    state.creds = limitedAfterHangUp(client, "slowp");
    const p = request("/v1/messages", { ...claudeBody, model: "duo" }, { earlyHeaders: true }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await p;
    expect(res.headers.get("Content-Type")).not.toContain("text/event-stream");
    expect(state.modelLookups).not.toContain("nextp/b");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a limit hold ends when the client hangs up, and retries nothing", async () => {
    state.settings.limitHoldEnabled = true;
    const client = new AbortController();
    let lookups = 0;
    state.creds = () => {
      lookups++;
      return {
        allRateLimited: true,
        allLimitsExhausted: true,
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
        retryAfterHuman: "reset after 1m",
        lastError: "usage_limit_reached",
        lastErrorCode: 429,
      };
    };
    const res = await request("/v1/messages", claudeBody, { earlyHeaders: true }, { signal: client.signal });
    expect(res.status).toBe(200);
    const out = read(res);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.text).toContain("limit reached");
    const before = lookups;
    const written = out.text;
    client.abort();
    // Ends now, not at the next retry 30s+ away.
    await vi.advanceTimersByTimeAsync(100);
    expect(out.done).toBe(true);
    expect(out.text).toBe(written);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lookups).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without early headers too, a hang-up stops the account loop", async () => {
    const client = new AbortController();
    state.core = (args) => later(100_000, () => ok(CLAUDE_REPLY), args.clientSignal);
    const p = request("/v1/messages", { ...claudeBody, stream: false }, { earlyHeaders: true }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    client.abort();
    expect((await p).status).toBe(499);
    expect(state.coreCalls).toHaveLength(1);
    expect(state.markCalls).toHaveLength(0);
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

describe("createLimitHoldResponse and the client's signal", () => {
  const hold = (signal, attempt) => createLimitHoldResponse({
    sourceFormat: "claude", model: "m", provider: "p", retryAtMs: Date.now() + 60_000, attempt, signal,
  });

  it("a hold built after the client left ends at once, with nothing written or retried", async () => {
    const client = new AbortController();
    client.abort();
    const attempt = vi.fn();
    const out = read(hold(client.signal, attempt));
    await out.pump;
    expect(out.text).toBe("");
    expect(attempt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hang-up during the wait ends the hold before its retry", async () => {
    const client = new AbortController();
    const attempt = vi.fn();
    const out = read(hold(client.signal, attempt));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(out.text).toContain("limit reached");
    client.abort();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await out.pump;
    expect(attempt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
