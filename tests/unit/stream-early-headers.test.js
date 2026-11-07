// Cloudflare answers 524 when the origin sends no response headers for ~100-120s.
// A streaming request whose upstream is that slow to answer gets 200 + SSE
// headers early, keepalives while routing carries on, then the real stream or
// an in-band error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { respondWithEarlyHeaders, buildEarlyErrorBytes } from "../../open-sse/utils/earlyHeaders.js";
import { SSE_KEEPALIVE, JSON_KEEPALIVE } from "../../open-sse/utils/sseConstants.js";
import { errorResponse } from "../../open-sse/utils/error.js";
import { createLimitHoldResponse } from "../../open-sse/utils/limitHold.js";
import { clientDemandsJson } from "../../open-sse/utils/replyShape.js";

const state = { settings: {}, accounts: [], exhausted: null, creds: null, core: null, coreCalls: [], markCalls: [], onMark: null, credLookups: 0, modelLookups: [] };

vi.mock("@/lib/localDb", () => ({ getSettings: async () => state.settings }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyLimitHold: async () => null }));
vi.mock("@/sse/services/auth.js", async () => {
  const actual = await vi.importActual("@/sse/services/auth.js");
  return {
    ...actual,
    extractApiKey: () => "sk-test",
    isValidApiKey: async () => true,
    getProviderCredentials: async (provider, exclude) => {
      state.credLookups++;
      return state.creds?.(provider, exclude)
        ?? state.accounts.find((a) => !exclude.has(a.connectionId)) ?? state.exhausted ?? null;
    },
    markAccountUnavailable: async (...args) => {
      state.markCalls.push(args);
      state.onMark?.();
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
    if (signal?.aborted) return resolve(fail(499, "Request aborted"));
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
  state.onMark = null;
  state.credLookups = 0;
  state.modelLookups = [];
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// Every event of an SSE text, parsed (comments skipped).
function events(text) {
  return text.split("\n\n").filter((e) => e.trim() && !e.startsWith(":")).map((e) => ({
    event: e.match(/^event: (.*)$/m)?.[1] || null,
    data: e.match(/^data: (.*)$/m)?.[1],
  }));
}
const errorOf = (bytes) => JSON.parse(events(dec.decode(bytes))[0].data);
// The response.failed payload of a Responses stream's text.
const failedOf = (text) => JSON.parse(events(text).find((e) => e.event === "response.failed").data);

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

  it("a client already gone when it's called gets run an aborted signal", async () => {
    const client = new AbortController();
    client.abort();
    let signal;
    const p = respondWithEarlyHeaders({ run: (s) => { signal = s; return later(100_000, () => sse(CLAUDE_REPLY), s); }, sourceFormat: "claude", signal: client.signal, delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
    expect((await p).status).toBe(499);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a client that leaves mid-reply cancels the piped stream", async () => {
    let ctrl;
    const cancel = vi.fn();
    const body = new ReadableStream({ start(c) { ctrl = c; }, cancel });
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => new Response(body, { headers: SSE_HEADERS })), sourceFormat: "claude", delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(10_000);
    ctrl.enqueue(enc.encode(CLAUDE_REPLY));
    await vi.advanceTimersByTimeAsync(0);
    expect(out.text).toContain(CLAUDE_REPLY);
    expect(cancel).not.toHaveBeenCalled();
    await out.reader.cancel("gone");
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledWith("gone");
  });

  it("a failure marked x-should-retry: false is final whatever its status", async () => {
    const reply = () => new Response("try later", { status: 503, headers: { "x-should-retry": "false" } });
    const claude = JSON.parse(events(await earlyRun(() => later(40_000, reply), "claude"))[0].data).error;
    expect(claude).toMatchObject({ message: "try later" });
    expect(claude.type).not.toBe("overloaded_error");
    const responses = failedOf(await earlyRun(() => later(40_000, reply), "openai-responses")).response.error;
    expect(responses.code).toBe("invalid_prompt");
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
    const code = (status, opts) => failedOf(dec.decode(buildEarlyErrorBytes(status, "nope", "openai-responses", opts))).response.error.code;
    expect(failedOf(dec.decode(buildEarlyErrorBytes(503, "nope", "openai-responses")))).toMatchObject({ type: "response.failed", response: { status: "failed", error: { message: "nope" } } });
    expect(code(503)).toBe("server_error");
    expect(code(409)).toBe("server_error");
    expect(code(429)).toBe("rate_limit_exceeded");
    expect(code(400)).toBe("invalid_prompt");
    expect(code(400, { retryable: false })).toBe("invalid_prompt");
  });

  it("a failed body's message reaches the Responses error; its code comes from the status", async () => {
    const body = Response.json({ error: { message: "too long", code: "bad_request" } }, { status: 400 });
    const text = await earlyRun(() => later(40_000, body), "openai-responses");
    expect(failedOf(text).response.error).toEqual({ type: "stream_error", code: "invalid_prompt", message: "too long" });
  });

  // openai-python's responses.stream() throws on any first event but response.created.
  it("Responses: a stream nothing opened gets response.created first, with the failure's id", () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const evs = events(dec.decode(buildEarlyErrorBytes(503, "nope", "openai-responses")));
    expect(evs.map((e) => e.event)).toEqual(["response.created", "response.failed"]);
    const [created, failed] = evs.map((e) => JSON.parse(e.data));
    expect(created).toMatchObject({ type: "response.created", response: { status: "in_progress" } });
    expect(created.response.id).toBe(failed.response.id);
    expect(events(dec.decode(buildEarlyErrorBytes(503, "nope", "openai-responses", { opened: true }))).map((e) => e.event)).toEqual(["response.failed"]);
  });

  it.each([
    ["a failed reply", () => later(40_000, () => new Response("down", { status: 503 }))],
    ["a thrown error", () => later(40_000, () => Promise.reject(new Error("boom")))],
    ["a stream that errors on its first read", () => later(40_000, () => new Response(new ReadableStream({ pull(c) { c.error(new Error("reset")); } }), { headers: SSE_HEADERS }))],
  ])("Responses: %s after early headers opens with response.created", async (_name, run) => {
    const text = await earlyRun(run, "openai-responses");
    expect(events(text).map((e) => e.event)).toEqual(["response.created", "response.failed"]);
  });

  it("Responses: a stream that errors after its own events gets only response.failed", async () => {
    const opened = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_up"}}\n\n';
    let sent = false;
    const body = new ReadableStream({
      pull(c) {
        if (sent) return c.error(new Error("reset"));
        sent = true;
        c.enqueue(enc.encode(opened));
      },
    });
    const text = await earlyRun(() => later(40_000, () => new Response(body, { headers: SSE_HEADERS })), "openai-responses");
    expect(events(text).map((e) => e.event)).toEqual(["response.created", "response.failed"]);
    expect(text.startsWith(SSE_KEEPALIVE) && text.includes(opened)).toBe(true);
    expect(JSON.parse(events(text)[0].data).response.id).toBe("resp_up");
  });

  it("a long failure body is cut to 2000 characters in the stream", async () => {
    const page = `<html>${"x".repeat(5_000)}</html>`;
    const text = await earlyRun(() => later(40_000, () => new Response(page, { status: 502 })), "claude");
    expect(JSON.parse(events(text)[0].data).error.message).toBe(page.slice(0, 2000));
  });

  it.each([
    ["a top-level message", () => Response.json({ message: "model not found" }, { status: 404 }), "model not found"],
    ["an empty body", () => new Response("", { status: 404 }), "Model not found"],
  ])("a failed body with %s is read like any upstream error", async (_name, reply, message) => {
    const text = await earlyRun(() => later(40_000, reply), "claude");
    expect(JSON.parse(events(text)[0].data).error.message).toBe(message);
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

  // Without `stream` or an Accept that asks for JSON, whether the client gets a
  // stream depends on the provider, so neither early shape is safe.
  it("a request that leaves stream out and doesn't ask for JSON is never committed early", async () => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const { stream: _stream, ...noStream } = claudeBody;
    const p = request("/v1/messages", noStream, { earlyHeaders: true }, { headers: { accept: "*/*" } });
    await vi.advanceTimersByTimeAsync(80_000);
    const res = await p;
    expect(res.status).toBe(503);
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
    const err = failedOf(out.text).response.error;
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

  it("a hang-up after a failed account tries no other account", async () => {
    const client = new AbortController();
    state.core = () => fail(503, "overloaded");
    // The client leaves while the first account is being locked.
    state.onMark = () => client.abort();
    const res = await request("/v1/messages", claudeBody, { earlyHeaders: true }, { signal: client.signal });
    expect(res.status).toBe(499);
    expect(state.coreCalls.map((c) => c.connectionId)).toEqual(["c1"]);
    expect(state.credLookups).toBe(1);
  });

  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  it.each([
    ["a fusion combo's panel", { combos: { fuse: ["slowp/a", "nextp/b"] }, comboStrategies: { fuse: { fallbackStrategy: "fusion" } } }, "fuse", ["slowp", "nextp"]],
    ["a capacity adapter", { capacityAdapter: { vision: { enabled: true, models: ["oc/mimo-v2.5-free"] } } }, "slowp/m1", ["oc"]],
    ["a nested fusion combo's panel", { combos: { outer: ["inner"], inner: ["slowp/a", "nextp/b"] }, comboStrategies: { inner: { fallbackStrategy: "fusion" } } }, "outer", ["slowp", "nextp"]],
    ["a nested fallback combo", { combos: { outer: ["inner"], inner: ["slowp/a", "nextp/b"] } }, "outer", ["slowp"]],
  ])("client leaves during %s: its upstream is aborted, nothing else is called", async (_name, settings, model, providers) => {
    Object.assign(state.settings, settings);
    const client = new AbortController();
    state.core = (args) => later(100_000, () => ok(CLAUDE_REPLY), args.clientSignal);
    const body = { ...openaiBody, model, messages: [{ role: "user", content: [{ type: "text", text: "hi" }, image] }] };
    const p = request("/v1/chat/completions", body, { earlyHeaders: true }, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    client.abort();
    await vi.advanceTimersByTimeAsync(200_000);
    await p;
    expect(state.coreCalls.map((c) => c.modelInfo.provider)).toEqual(providers);
    expect(state.coreCalls.every((c) => c.clientSignal?.aborted === true)).toBe(true);
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

  // Every account of every provider limited, reset a minute away; counts the lookups.
  const alwaysLimited = () => {
    let lookups = 0;
    return {
      lookups: () => lookups,
      creds: () => {
        lookups++;
        return {
          allRateLimited: true,
          allLimitsExhausted: true,
          retryAfter: new Date(Date.now() + 60_000).toISOString(),
          retryAfterHuman: "reset after 1m",
          lastError: "usage_limit_reached",
          lastErrorCode: 429,
        };
      },
    };
  };

  it.each([
    ["a single model", "slowp/m1", null],
    ["a combo", "duo", { duo: ["slowp/a", "nextp/b"] }],
  ])("a limit hold on %s ends when the client hangs up, and retries nothing", async (_name, model, combos) => {
    state.settings.limitHoldEnabled = true;
    if (combos) state.settings.combos = combos;
    const client = new AbortController();
    const hold = alwaysLimited();
    state.creds = hold.creds;
    const res = await request("/v1/messages", { ...claudeBody, model }, { earlyHeaders: true }, { signal: client.signal });
    expect(res.status).toBe(200);
    const out = read(res);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.text).toContain("limit reached");
    const before = hold.lookups();
    const written = out.text;
    client.abort();
    // Ends now, not at the next retry 30s+ away.
    await vi.advanceTimersByTimeAsync(100);
    expect(out.done).toBe(true);
    expect(out.text).toBe(written);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(hold.lookups()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["a single model", "/v1/messages", { ...claudeBody, stream: false }, {}, 429],
    ["a fusion combo", "/v1/chat/completions", { ...openaiBody, model: "fuse", stream: false },
      { combos: { fuse: ["slowp/a", "nextp/b"] }, comboStrategies: { fuse: { fallbackStrategy: "fusion" } } }, 503],
    ["a capacity adapter", "/v1/chat/completions",
      { ...openaiBody, stream: false, messages: [{ role: "user", content: [{ type: "text", text: "hi" }, image] }] },
      { capacityAdapter: { vision: { enabled: true, models: ["oc/mimo-v2.5-free"] } } }, 429],
  ])("a JSON request's limit hold on %s ends when the client hangs up, and retries nothing", async (_name, path, body, settings, status) => {
    state.settings.limitHoldEnabled = true;
    Object.assign(state.settings, settings);
    const client = new AbortController();
    const hold = alwaysLimited();
    state.creds = hold.creds;
    const p = request(path, body, {}, { signal: client.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    const before = hold.lookups();
    client.abort();
    await vi.advanceTimersByTimeAsync(100);
    const res = await p;
    expect(res.status).toBe(status);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(hold.lookups()).toBe(before);
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

// A non-streaming client (Claude Code's non-streaming fallback, the OpenAI and
// Anthropic SDKs' create() without stream) reads one JSON body. Committed early
// it gets 200 + application/json, a newline per keepalive, then the body.
const CLAUDE_MESSAGE = { id: "msg_1", type: "message", role: "assistant", model: "m1", content: [{ type: "text", text: "pong" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const jsonOk = (body = CLAUDE_MESSAGE) => ({ success: true, response: Response.json(body) });
// What both SDKs do with a JSON content type: read the text and JSON.parse it.
const sdkParse = (text) => new Response(text, { headers: { "content-type": "application/json" } }).json();

async function earlyJsonRun(run, sourceFormat, settleMs = 10_000) {
  const p = respondWithEarlyHeaders({ run, sourceFormat, json: true, delayMs: DELAY, keepaliveMs: KEEPALIVE });
  await vi.advanceTimersByTimeAsync(DELAY);
  const res = await p;
  expect(res.status).toBe(200);
  const out = read(res);
  await vi.advanceTimersByTimeAsync(settleMs);
  await out.pump;
  return out.text;
}

describe("respondWithEarlyHeaders for a JSON client", () => {
  it("a slow answer gets 200 JSON headers at the delay, a newline per keepalive, then the body", async () => {
    const p = respondWithEarlyHeaders({ run: () => later(100_000, () => Response.json(CLAUDE_MESSAGE)), sourceFormat: "claude", json: true, delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Length")).toBeNull();
    const out = read(res);
    await vi.advanceTimersByTimeAsync(0);
    expect(out.text).toBe(JSON_KEEPALIVE);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(out.text).toBe(JSON_KEEPALIVE.repeat(5));
    await vi.advanceTimersByTimeAsync(10_000);
    await out.pump;
    expect(out.text).toBe(JSON_KEEPALIVE.repeat(5) + JSON.stringify(CLAUDE_MESSAGE));
    expect(await sdkParse(out.text)).toEqual(CLAUDE_MESSAGE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast answer is returned as is, real status and headers included", async () => {
    const real = Response.json({ error: { message: "nope" } }, { status: 429, headers: { "retry-after": "7" } });
    const p = respondWithEarlyHeaders({ run: () => later(5_000, real), sourceFormat: "claude", json: true, delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBe(real);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["delay 0", 0, KEEPALIVE],
    ["keepalive 0", DELAY, 0],
  ])("%s turns it off", async (_name, delayMs, keepaliveMs) => {
    const real = new Response("x", { status: 503 });
    const p = respondWithEarlyHeaders({ run: () => later(120_000, real), sourceFormat: "claude", json: true, delayMs, keepaliveMs });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await p).toBe(real);
  });

  it.each([
    ["claude", 503, (b) => expect(b).toEqual({ type: "error", error: { type: "overloaded_error", message: "overloaded", code: "service_unavailable" } })],
    ["claude", 400, (b) => expect(b).toEqual({ type: "error", error: { type: "invalid_request_error", message: "overloaded", code: "bad_request" } })],
    ["openai", 503, (b) => expect(b).toEqual({ error: { message: "overloaded", type: "server_error", code: "service_unavailable" } })],
    ["openai-responses", 503, (b) => expect(b).toMatchObject({ object: "response", status: "failed", output: [], error: { message: "overloaded", code: "server_error" } })],
    ["openai-responses", 429, (b) => expect(b.error.code).toBe("rate_limit_exceeded")],
    ["openai-responses", 400, (b) => expect(b.error.code).toBe("invalid_prompt")],
  ])("a slow %s failure (%i) is written as that API's error body", async (format, status, check) => {
    const text = await earlyJsonRun(() => later(40_000, () => errorResponse(status, "overloaded")), format);
    expect(text.startsWith(JSON_KEEPALIVE)).toBe(true);
    check(await sdkParse(text));
  });

  it("an unexpected throw is a generic 500 error body, the detail only in the log", async () => {
    const log = { error: vi.fn(), info: vi.fn() };
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => Promise.reject(new Error("secret internals"))), sourceFormat: "openai", json: true, delayMs: DELAY, keepaliveMs: KEEPALIVE, log });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(20_000);
    await out.pump;
    expect(out.text).not.toContain("secret");
    expect((await sdkParse(out.text)).error.message).toBe("Internal server error");
    expect(log.error.mock.calls[0][1]).toContain("secret internals");
  });

  it("an ok stream where JSON was due is a 502 error body, and the stream is cancelled", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const text = await earlyJsonRun(() => later(40_000, () => new Response(body, { headers: SSE_HEADERS })), "openai");
    expect((await sdkParse(text)).error.message).toBe("upstream reply was not JSON");
    expect(cancel).toHaveBeenCalled();
  });

  it("a body that fails before its first byte becomes an error body", async () => {
    const body = new ReadableStream({ pull(c) { c.error(new Error("reset")); } });
    const text = await earlyJsonRun(() => later(40_000, () => new Response(body, { headers: { "content-type": "application/json" } })), "claude");
    expect((await sdkParse(text)).type).toBe("error");
  });

  // Half a JSON body can't be finished into valid JSON: cut the connection,
  // which both SDKs raise as an error, rather than end it as if it were whole.
  it("a body that fails halfway errors the reply instead of ending it", async () => {
    let ctrl;
    const body = new ReadableStream({ start(c) { ctrl = c; } });
    const p = respondWithEarlyHeaders({ run: () => later(40_000, () => new Response(body, { headers: { "content-type": "application/json" } })), sourceFormat: "claude", json: true, delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    const reader = res.body.getReader();
    const chunks = [];
    const all = (async () => { for (;;) { const r = await reader.read(); if (r.done) return "done"; chunks.push(dec.decode(r.value)); } })().catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    ctrl.enqueue(enc.encode('{"id":"msg_1",'));
    await vi.advanceTimersByTimeAsync(0);
    ctrl.error(new Error("upstream reset"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await all).toBeInstanceOf(Error);
    expect(chunks.join("")).toContain('{"id":"msg_1",');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a client that leaves while waiting aborts run's signal and clears the timers", async () => {
    let signal;
    const p = respondWithEarlyHeaders({ run: (s) => { signal = s; return later(100_000, () => Response.json(CLAUDE_MESSAGE), s); }, sourceFormat: "claude", json: true, delayMs: DELAY, keepaliveMs: KEEPALIVE });
    await vi.advanceTimersByTimeAsync(DELAY);
    const out = read(await p);
    await vi.advanceTimersByTimeAsync(KEEPALIVE);
    expect(signal.aborted).toBe(false);
    await out.reader.cancel();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("handleChat early headers for a non-streaming request", () => {
  const claudeJson = { ...claudeBody, stream: false };
  const { stream: _s, ...openaiNoStream } = openaiBody;
  // The OpenAI and Anthropic SDKs leave `stream` out of a create() call and send this.
  const SDK_ACCEPT = { headers: { accept: "application/json" } };

  // Claude Code and both SDKs send Accept: application/json on a streaming call too.
  it.each([
    ["/v1/messages", claudeBody],
    ["/v1/chat/completions", openaiBody],
    ["/v1/responses", { model: "slowp/m1", stream: true, input: "hi" }],
  ])("stream: true with the SDK's Accept still gets an SSE stream on %s", async (path, body) => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const p = request(path, body, { earlyHeaders: true }, SDK_ACCEPT);
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const out = read(res);
    await vi.advanceTimersByTimeAsync(60_000);
    await out.pump;
  });

  it.each([
    [{ stream: true }, { accept: "application/json" }, false],
    [{ stream: true }, null, false],
    [{ stream: false }, { accept: "text/event-stream" }, true],
    [{}, { accept: "application/json" }, true],
    [{}, { accept: "application/json, text/event-stream" }, false],
    [{}, { accept: "*/*" }, false],
    [{}, null, false],
  ])("clientDemandsJson(%j, %j) is %s", (body, headers, want) => {
    expect(clientDemandsJson(body, headers)).toBe(want);
  });

  it("a fast answer is the routed Response itself", async () => {
    const reply = jsonOk();
    state.core = () => reply;
    const res = await request("/v1/messages", claudeJson, { earlyHeaders: true });
    expect(res).toBe(reply.response);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast failure keeps its real HTTP status", async () => {
    state.core = () => fail(503, "overloaded");
    const res = await request("/v1/messages", claudeJson, { earlyHeaders: true });
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("the outage: first account hangs 92s then 500s, the next answers; 200 with the reply, the first account locked", async () => {
    state.core = (args, n) => (n === 1
      ? later(92_000, () => ({ success: false, status: 500, error: "", response: Response.json({ message: "" }, { status: 500 }) }), args.clientSignal)
      : later(40_000, () => jsonOk(), args.clientSignal));
    const p = request("/v1/messages", claudeJson, { earlyHeaders: true });
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const out = read(res);
    await vi.advanceTimersByTimeAsync(110_000);
    await out.pump;
    // Never more than one keepalive interval without a byte.
    expect(out.text.split(JSON_KEEPALIVE).length - 1).toBeGreaterThanOrEqual(Math.floor((132_000 - DELAY) / KEEPALIVE));
    expect(await sdkParse(out.text)).toEqual(CLAUDE_MESSAGE);
    expect(state.coreCalls.map((c) => c.connectionId)).toEqual(["c1", "c2"]);
    expect(state.markCalls.map((c) => c[0])).toEqual(["c1"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["/v1/messages", claudeJson, {}, (b) => expect(b).toMatchObject({ type: "error", error: { type: "overloaded_error", message: expect.stringContaining("overloaded") } })],
    ["/v1/chat/completions", { ...openaiBody, stream: false }, {}, (b) => expect(b).toMatchObject({ error: { message: expect.stringContaining("overloaded"), type: "server_error" } })],
    ["/v1/chat/completions (SDK, no stream)", openaiNoStream, SDK_ACCEPT, (b) => expect(b.error.message).toContain("overloaded")],
    ["/v1/responses", { model: "slowp/m1", stream: false, input: "hi" }, {}, (b) => expect(b).toMatchObject({ object: "response", status: "failed", error: { code: "server_error", message: expect.stringContaining("overloaded") } })],
  ])("slow and every account fails: an error body on %s", async (path, body, extra, check) => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const p = request(path.split(" ")[0], body, { earlyHeaders: true }, extra);
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const out = read(res);
    await vi.advanceTimersByTimeAsync(60_000);
    await out.pump;
    check(await sdkParse(out.text));
    expect(state.coreCalls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an SDK call without stream on /v1/chat/completions gets its slow reply as JSON", async () => {
    const completion = { id: "c1", object: "chat.completion", created: 1, model: "m1", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] };
    state.core = (args) => later(50_000, () => jsonOk(completion), args.clientSignal);
    const p = request("/v1/chat/completions", openaiNoStream, { earlyHeaders: true }, SDK_ACCEPT);
    await vi.advanceTimersByTimeAsync(DELAY);
    const res = await p;
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const out = read(res);
    await vi.advanceTimersByTimeAsync(30_000);
    await out.pump;
    expect(await sdkParse(out.text)).toEqual(completion);
  });

  it("client leaves after the headers: upstream aborted, no other account tried or locked, no timer left", async () => {
    state.core = (args) => later(100_000, () => jsonOk(), args.clientSignal);
    const p = request("/v1/messages", claudeJson, { earlyHeaders: true });
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

  it("off for routes that don't ask for it", async () => {
    state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
    const p = request("/v1/messages", claudeJson);
    await vi.advanceTimersByTimeAsync(80_000);
    expect((await p).status).toBe(503);
  });

  describe("kill switches", () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
    // A slow failure on a JSON and a streaming request, checked at the delay.
    const atDelay = async (env) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      vi.resetModules();
      const { handleChat: fresh } = await import("@/sse/handlers/chat.js");
      state.core = (args) => later(40_000, fail(503, "overloaded"), args.clientSignal);
      const send = (body) => fresh(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), null, { earlyHeaders: true });
      const settledBy = (p) => Promise.race([p.then((r) => r.headers.get("Content-Type")), new Promise((r) => setTimeout(r, DELAY + 1, "pending"))]);
      const json = settledBy(send(claudeJson));
      const stream = settledBy(send(claudeBody));
      await vi.advanceTimersByTimeAsync(DELAY + 1);
      const out = { json: await json, stream: await stream };
      await vi.advanceTimersByTimeAsync(60_000);
      return out;
    };

    it("NON_STREAM_EARLY_HEADERS_MS=0 turns off only the JSON reply", async () => {
      expect(await atDelay({ NON_STREAM_EARLY_HEADERS_MS: "0" })).toEqual({ json: "pending", stream: "text/event-stream" });
    });

    it.each([
      ["STREAM_EARLY_HEADERS_MS=0", { STREAM_EARLY_HEADERS_MS: "0" }],
      ["STREAM_KEEPALIVE_MS=0", { STREAM_KEEPALIVE_MS: "0" }],
    ])("%s turns off both", async (_name, env) => {
      expect(await atDelay(env)).toEqual({ json: "pending", stream: "pending" });
    });

    it("by default both commit early", async () => {
      expect(await atDelay({})).toEqual({ json: "application/json", stream: "text/event-stream" });
    });
  });
});

describe("NON_STREAM_EARLY_HEADERS_MS", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const load = async (env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    return (await import("../../open-sse/config/runtimeConfig.js")).NON_STREAM_EARLY_HEADERS_MS;
  };

  it("follows STREAM_EARLY_HEADERS_MS unless set, accepts 0, ignores junk", async () => {
    expect(await load({})).toBe(30_000);
    expect(await load({ STREAM_EARLY_HEADERS_MS: "0" })).toBe(0);
    expect(await load({ STREAM_EARLY_HEADERS_MS: "20000" })).toBe(20_000);
    expect(await load({ STREAM_EARLY_HEADERS_MS: "", NON_STREAM_EARLY_HEADERS_MS: "0" })).toBe(0);
    expect(await load({ STREAM_EARLY_HEADERS_MS: "0", NON_STREAM_EARLY_HEADERS_MS: "45000" })).toBe(45_000);
    expect(await load({ STREAM_EARLY_HEADERS_MS: "", NON_STREAM_EARLY_HEADERS_MS: "soon" })).toBe(30_000);
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
