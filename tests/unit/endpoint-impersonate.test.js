// Client-gated endpoints (agentrouter, 2026-10-18): every request without a known
// client's headers gets 401 "unauthorized client detected" before the key is checked.
import { describe, it, expect } from "vitest";

const { detectEndpoint } = await import("@/lib/endpointDetect.js");
const { findClientIdentity, retryAsClient, withClientHeaders, presetHeaders } = await import("@/lib/endpointImpersonate.js");

const KEY = "sk-real-key-0123456789";
const BASE = "https://agentrouter.example/v1";

// Lets in codex_cli_rs and claude-cli (by user-agent or originator), like agentrouter.
function gatedFetch({ allow = /codex_cli_rs|claude-cli/ } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers: h, body: init.body });
    const res = (status, obj) => ({ status, text: async () => JSON.stringify(obj), headers: { get: (n) => (n === "content-type" ? "application/json" : null) } });
    if (!allow.test(`${h["user-agent"] || ""} ${h.originator || ""}`)) return res(401, { error: { message: "unauthorized client detected", type: "unauthorized_client_error" } });
    if (h.authorization !== `Bearer ${KEY}` && h["x-api-key"] !== KEY) return res(401, { error: { message: "无效的令牌", type: "new_api_error" } });
    const path = new URL(url).pathname;
    if (init.method === "GET" && path === "/v1/models") return res(200, { object: "list", data: [{ id: "gpt-5-codex" }, { id: "claude-sonnet-5" }] });
    if (path === "/v1/chat/completions") {
      const b = JSON.parse(init.body || "{}");
      if (!b.messages?.length) return res(400, { error: { message: "messages: must contain at least 1 item", type: "invalid_request_error" } });
      return res(503, { error: { message: "无可用渠道", type: "new_api_error" } });
    }
    return res(404, { error: { message: "Not found" } });
  };
  return { fn, calls };
}

describe("presets", () => {
  it("headers come from the shared preset text", () => {
    expect(presetHeaders("codex")).toEqual({ "user-agent": expect.stringMatching(/^codex_cli_rs\//), originator: "codex_cli_rs" });
  });
  it("withClientHeaders replaces the same header in any case", async () => {
    const { fn, calls } = gatedFetch();
    await withClientHeaders(fn, "codex")(`${BASE}/models`, { method: "GET", headers: { "User-Agent": "node" }, signal: AbortSignal.timeout(1000) });
    expect(calls[0].headers["user-agent"]).toMatch(/^codex_cli_rs/);
  });
});

describe("findClientIdentity", () => {
  it("reports which clients get past the gate, free requests only", async () => {
    const { fn, calls } = gatedFetch();
    const { works, steps } = await findClientIdentity({ url: BASE, apiKey: KEY, fetchFn: fn });
    expect(works).toEqual(["codex", "claude-code"]);
    expect(steps.some((s) => s.label.includes("as Gemini CLI"))).toBe(true);
    // Never a non-empty conversation.
    for (const c of calls) if (c.body) expect(JSON.parse(c.body).messages).toEqual([]);
    expect(JSON.stringify(steps)).not.toContain(KEY);
  });
  it("finds nothing when the gate takes no preset", async () => {
    const { fn } = gatedFetch({ allow: /never/ });
    expect((await findClientIdentity({ url: BASE, apiKey: KEY, fetchFn: fn })).works).toEqual([]);
  });
});

describe("retryAsClient", () => {
  it("turns a clientGated failure into a working result with the gate named", async () => {
    const { fn } = gatedFetch();
    const first = await detectEndpoint({ url: BASE, apiKey: KEY, fetchFn: fn, deadlineMs: 20_000 });
    expect(first.ok).toBe(false);
    expect(first.clientGated).toBe(true);
    const r = await retryAsClient(first, { url: BASE, apiKey: KEY, fetchFn: fn, detect: (f) => detectEndpoint({ url: BASE, apiKey: KEY, fetchFn: f, deadlineMs: 20_000 }) });
    expect(r.ok).toBe(true);
    expect(r.gate).toEqual({ client: "codex", label: "Codex CLI", alsoWorks: "Claude Code" });
    expect(r.protocol).toBe("openai-chat");
    expect(r.models).toEqual(expect.arrayContaining(["gpt-5-codex", "claude-sonnet-5"]));
    expect(r.steps.length).toBeGreaterThan(first.steps.length);
  });
  it("leaves results alone that aren't client-gated", async () => {
    const res = { ok: false, error: "The key was rejected.", steps: [], clientGated: false };
    expect(await retryAsClient(res, { url: BASE, fetchFn: async () => { throw new Error("no"); }, detect: async () => { throw new Error("no"); } })).toBe(res);
  });
  it("answers with the key refusal once a client gets past the gate, not the gate", async () => {
    // A dead key: the gate lets Codex through, then the key itself is refused.
    const { fn } = gatedFetch();
    const dead = "sk-dead-key-0123456789";
    const first = await detectEndpoint({ url: BASE, apiKey: dead, fetchFn: fn, deadlineMs: 20_000 });
    expect(first).toMatchObject({ ok: false, failure: "gated", keyVerdict: null });
    const r = await retryAsClient(first, { url: BASE, apiKey: dead, fetchFn: fn, detect: (f) => detectEndpoint({ url: BASE, apiKey: dead, fetchFn: f, deadlineMs: 20_000 }) });
    expect(r).toMatchObject({ ok: false, failure: "key", keyVerdict: "refused" });
    expect(r.gate).toBeUndefined();
    expect(r.steps.length).toBeGreaterThan(first.steps.length);
  });
  it("answers with a rate limit once a client gets past the gate, not the gate", async () => {
    const fn = async (url, init) => {
      const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const res = (status, obj) => ({ status, text: async () => JSON.stringify(obj), headers: { get: (n) => (n === "content-type" ? "application/json" : null) } });
      if (!/codex_cli_rs/.test(`${h["user-agent"] || ""} ${h.originator || ""}`)) return res(401, { error: { message: "unauthorized client detected", type: "unauthorized_client_error" } });
      return res(429, { error: { message: "rate limited", type: "rate_limit_error" } });
    };
    const first = await detectEndpoint({ url: BASE, apiKey: KEY, fetchFn: fn, deadlineMs: 20_000, sleep: async () => {} });
    expect(first).toMatchObject({ ok: false, failure: "gated" });
    const r = await retryAsClient(first, { url: BASE, apiKey: KEY, fetchFn: fn, detect: (f) => detectEndpoint({ url: BASE, apiKey: KEY, fetchFn: f, deadlineMs: 20_000, sleep: async () => {} }) });
    expect(r).toMatchObject({ ok: false, failure: "rate", keyVerdict: "rate-limited" });
  });
  it("keeps the gate's message, with the key's verdict, when the retry found no API", async () => {
    // Past the gate, GET /models lists with the key, then every POST refuses it.
    const fn = async (url, init) => {
      const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const res = (status, obj) => ({ status, text: async () => JSON.stringify(obj), headers: { get: (n) => (n === "content-type" ? "application/json" : null) } });
      if (!/codex_cli_rs/.test(`${h["user-agent"] || ""} ${h.originator || ""}`)) return res(401, { error: { message: "unauthorized client detected", type: "unauthorized_client_error" } });
      if (init.method === "GET" && new URL(url).pathname === "/v1/models") return h.authorization ? res(200, { object: "list", data: [{ id: "m1" }] }) : res(401, { error: { message: "missing key", type: "authentication_error" } });
      return res(401, { error: { message: "insufficient permissions", type: "authentication_error" } });
    };
    const first = await detectEndpoint({ url: BASE, apiKey: KEY, fetchFn: fn, deadlineMs: 20_000 });
    const r = await retryAsClient(first, { url: BASE, apiKey: KEY, fetchFn: fn, detect: (f) => detectEndpoint({ url: BASE, apiKey: KEY, fetchFn: f, deadlineMs: 20_000 }) });
    expect(r).toMatchObject({ ok: false, failure: "gated", keyVerdict: "refused" });
    expect(r.error).toMatch(/only accepts specific clients/);
  });
  it("keeps the failure (with the extra steps) when no client gets in", async () => {
    const { fn } = gatedFetch({ allow: /never/ });
    const first = await detectEndpoint({ url: BASE, apiKey: KEY, fetchFn: fn, deadlineMs: 20_000 });
    const r = await retryAsClient(first, { url: BASE, apiKey: KEY, fetchFn: fn, detect: () => { throw new Error("not called"); } });
    expect(r.ok).toBe(false);
    expect(r.gate).toBeUndefined();
  });
});
