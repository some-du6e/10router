// Advanced / Ultra advanced settings of a custom endpoint, applied to the real
// upstream request (open-sse/handlers/chatCore/endpointOverrides.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...a) => fetchMock(...a) }));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { makeReplyFilter, filterResponse, filterSseEvent, streamOverride } = await import("../../open-sse/handlers/chatCore/endpointOverrides.js");
const { sanitizeNodeQuirks, MIMIC_HEADERS, CLIENT_VERSIONS } = await import("@/shared/utils/nodeQuirks.js");
const { buildSampleRequest, parseHeaderLines, applyBodyOverrides, deepMerge, applyUrlOverrides } = await import("@/shared/utils/endpointOverrides.js");
const { CLAUDE_CLI_VERSION } = await import("../../open-sse/providers/shared.js");
const { PROVIDERS } = await import("../../open-sse/config/providers.js");
const { mergeConnectionData } = await import("@/shared/utils/nodeQuirkMerge.js");

const ok = (body = "{}", type = "application/json") => new Response(body, { status: 200, headers: { "content-type": type } });
const creds = (psd) => ({ apiKey: "sk-test-1234567890", providerSpecificData: { baseUrl: "https://gw.example.com/v1", ...psd } });
const sent = () => fetchMock.mock.calls.at(-1);
const hdr = (call, name) => { const h = call[1].headers; const k = Object.keys(h).find((x) => x.toLowerCase() === name); return k ? h[k] : undefined; };

beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(ok()); });

describe("sanitizeNodeQuirks: new keys", () => {
  it("keeps valid settings and drops broken ones", () => {
    const q = sanitizeNodeQuirks({
      authHeader: "x-api-key", mimic: "codex", blockForeignTools: true, stripReasoning: true,
      overrides: { path: "/v2/chat", query: "?api-version=1", body: "{\"temperature\":0.2}", stream: "never", timeout: "30", retries: "2", proxy: "socks5://127.0.0.1:1080", headers: "x-org: a\n-user-agent", drop: "stream_options", models: "a => b" },
    });
    expect(q.authHeader).toBe("x-api-key");
    expect(q.mimic).toBe("codex");
    expect(q.overrides).toEqual({ path: "/v2/chat", query: "api-version=1", body: "{\"temperature\":0.2}", stream: "never", timeout: "30", retries: "2", proxy: "socks5://127.0.0.1:1080", headers: "x-org: a\n-user-agent", drop: "stream_options", models: "a => b" });
  });
  it("never saves broken JSON, a host in the path, a bad proxy or CRLF", () => {
    const q = sanitizeNodeQuirks({ authHeader: "basic", mimic: "evil", overrides: { body: "{oops", path: "https://evil.com/x", proxy: "ftp://x", query: "a=1\r\nx: y", timeout: "-1", retries: "99", stream: "sometimes" } });
    expect(q).toEqual({});
    expect(sanitizeNodeQuirks({ overrides: { body: "[1,2]" } })).toEqual({});
  });
  it("keepEmpty lets an edit turn things off, and the node copies them onto keys", () => {
    const q = sanitizeNodeQuirks({ authHeader: null, mimic: "none", overrides: {}, blockForeignTools: false }, { keepEmpty: true });
    expect(q).toEqual({ authHeader: null, mimic: "none", overrides: {}, blockForeignTools: false });
    const psd = mergeConnectionData({ baseUrl: "x", mimic: "codex" }, { mimic: "none", overrides: { path: "/p" } });
    expect(psd).toMatchObject({ baseUrl: "x", mimic: "none", overrides: { path: "/p" } });
  });
});

describe("client presets match the executors' own identity", () => {
  it("uses the same versions as the Claude, Codex and Gemini CLI executors", () => {
    expect(CLIENT_VERSIONS.claudeCode).toBe(CLAUDE_CLI_VERSION);
    expect(MIMIC_HEADERS.codex).toContain(PROVIDERS.codex.headers["User-Agent"]);
    expect(CLIENT_VERSIONS.geminiCli).toBe(PROVIDERS["gemini-cli"].cliVersion);
    expect(CLIENT_VERSIONS.geminiApiClient).toBe(PROVIDERS["gemini-cli"].apiClient);
  });
});

describe("DefaultExecutor applies the overrides upstream", () => {
  const ex = () => new DefaultExecutor("openai-compatible-chat-x");
  const run = (psd, body = { model: "m1", messages: [{ role: "user", content: "hi" }], max_tokens: 5, stream: true, stream_options: { include_usage: true } }, stream = true) =>
    ex().execute({ model: "m1", body, stream, credentials: creds(psd) });

  it("leaves a node without settings alone", async () => {
    await run({});
    const [url, init] = sent();
    expect(url).toBe("https://gw.example.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test-1234567890");
    expect(JSON.parse(init.body).stream_options).toEqual({ include_usage: true });
  });

  it("path, query, headers, body merge, drop, renames", async () => {
    await run({ overrides: { path: "/v2/chat", query: "api-version=2024-10-21", headers: "x-org-id: acme\n-content-type\nContent-Type: application/json; charset=utf-8", body: "{\"temperature\":0.2,\"max_tokens\":null,\"metadata\":{\"team\":\"infra\"}}", drop: "stream_options", models: "m1 => vendor/m1" } });
    const [url, init] = sent();
    expect(url).toBe("https://gw.example.com/v1/v2/chat?api-version=2024-10-21");
    expect(hdr(sent(), "x-org-id")).toBe("acme");
    expect(hdr(sent(), "content-type")).toBe("application/json; charset=utf-8");
    const b = JSON.parse(init.body);
    expect(b).toMatchObject({ model: "vendor/m1", temperature: 0.2, metadata: { team: "infra" } });
    expect(b.max_tokens).toBeUndefined();
    expect(b.stream_options).toBeUndefined();
  });

  it("auth header styles", async () => {
    for (const [mode, want] of [["x-api-key", { "x-api-key": "sk-test-1234567890", authorization: undefined }], ["api-key", { "api-key": "sk-test-1234567890", authorization: undefined }], ["both", { "x-api-key": "sk-test-1234567890", authorization: "Bearer sk-test-1234567890" }]]) {
      await run({ authHeader: mode });
      for (const [k, v] of Object.entries(want)) expect(hdr(sent(), k)).toBe(v);
    }
  });

  it("pretends to be Codex; preset beta flags stay off OpenAI paths", async () => {
    await run({ mimic: "codex" });
    expect(hdr(sent(), "user-agent")).toBe(`codex_cli_rs/${CLIENT_VERSIONS.codex}`);
    expect(hdr(sent(), "originator")).toBe("codex_cli_rs");
    await run({ mimic: "claude-code" });
    expect(hdr(sent(), "user-agent")).toMatch(/^claude-cli\//);
    expect(hdr(sent(), "anthropic-beta")).toBeUndefined();
  });

  it("on Messages, a preset's flags still respect dropped / strip-all", async () => {
    const a = new DefaultExecutor("anthropic-compatible-x");
    await a.execute({ model: "c", body: { model: "c", messages: [], max_tokens: 1 }, stream: false, credentials: creds({ mimic: "claude-code", droppedBetas: ["interleaved-thinking-2025-05-14"] }) });
    expect(hdr(sent(), "anthropic-beta")).toBe("claude-code-20250219");
    await a.execute({ model: "c", body: { model: "c", messages: [], max_tokens: 1 }, stream: false, credentials: creds({ mimic: "claude-code", stripBeta: true }) });
    expect(hdr(sent(), "anthropic-beta")).toBeUndefined();
  });

  it("streaming never/always sets the body flag", async () => {
    await run({ overrides: { stream: "never" } });
    const b = JSON.parse(sent()[1].body);
    expect(b.stream).toBe(false);
    expect(b.stream_options).toBeUndefined();
    expect(streamOverride("openai-compatible-chat-x", creds({ overrides: { stream: "always" } }))).toBe("always");
    expect(streamOverride("openai", creds({ overrides: { stream: "always" } }))).toBeNull();
  });

  it("retries and proxy", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 503 })).mockResolvedValueOnce(ok());
    vi.useFakeTimers();
    const p = run({ overrides: { retries: "1", proxy: "http://127.0.0.1:3128" } });
    await vi.runAllTimersAsync();
    const r = await p;
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.response.status).toBe(200);
    expect(sent()[2]).toMatchObject({ connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:3128", strictProxy: true });
  });

  it("retries 0 turns the default 502 retries off", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("x", { status: 502 }));
    const r = await run({ overrides: { retries: "0" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.response.status).toBe(502);
  });

  it("ignores settings on built-in providers", async () => {
    await new DefaultExecutor("openai").execute({ model: "m", body: { model: "m" }, stream: false, credentials: { apiKey: "k", providerSpecificData: { overrides: { path: "/evil" }, mimic: "codex" } } });
    expect(sent()[0]).not.toContain("/evil");
    expect(hdr(sent(), "originator")).toBeUndefined();
  });
});

describe("reply filters", () => {
  const offered = new Set(["read_file"]);
  it("drops tool calls the client never offered (chat JSON) and fixes finish_reason", () => {
    const f = makeReplyFilter({ blockForeignTools: true, stripReasoning: true, offered });
    const out = f.whole({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, reasoning_content: "hmm", tool_calls: [{ id: "1", type: "function", function: { name: "run_shell", arguments: "{}" } }] } }] });
    expect(out.choices[0].message.tool_calls).toBeUndefined();
    expect(out.choices[0].message.reasoning_content).toBeUndefined();
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(f.dropped()).toBe(1);
  });
  it("keeps offered tools and renumbers streamed indices", () => {
    const f = makeReplyFilter({ blockForeignTools: true, stripReasoning: false, offered });
    const a = f.event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "x", function: { name: "run_shell", arguments: "" } }] } }] });
    expect(a.choices[0].delta.tool_calls).toBeUndefined();
    const b = f.event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "y", function: { name: "read_file", arguments: "" } }] } }] });
    expect(b.choices[0].delta.tool_calls[0].index).toBe(0);
    const c = f.event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"cmd\":\"rm\"}" } }] } }] });
    expect(c.choices[0].delta.tool_calls).toBeUndefined();
  });
  it("Anthropic stream: drops thinking and foreign tool_use blocks, renumbers", () => {
    const f = makeReplyFilter({ blockForeignTools: true, stripReasoning: true, offered });
    expect(f.event({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })).toBeNull();
    expect(f.event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } })).toBeNull();
    expect(f.event({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }).index).toBe(0);
    expect(f.event({ type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "bash" } })).toBeNull();
    expect(f.event({ type: "message_delta", delta: { stop_reason: "tool_use" } }).delta.stop_reason).toBe("end_turn");
  });
  it("SSE events round-trip and a whole response is filtered", async () => {
    const f = makeReplyFilter({ blockForeignTools: false, stripReasoning: true, offered });
    expect(filterSseEvent("data: [DONE]", f)).toBe("data: [DONE]");
    const sse = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}\n\n";
    const res = filterResponse(new Response(sse, { headers: { "content-type": "text/event-stream" } }), f);
    const text = await res.text();
    expect(text).not.toContain("thinking");
    expect(text).toContain("\"index\":0");
  });
  it("runs inside execute for a node that turned it on", async () => {
    fetchMock.mockResolvedValue(ok(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "x", tool_calls: [{ id: "1", function: { name: "evil", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })));
    const r = await new DefaultExecutor("openai-compatible-chat-x").execute({ model: "m", body: { model: "m", messages: [], tools: [{ type: "function", function: { name: "read_file" } }] }, stream: false, credentials: creds({ blockForeignTools: true }) });
    const j = await r.response.json();
    expect(j.choices[0].message.tool_calls).toBeUndefined();
  });
});

describe("shared request shaping (the preview)", () => {
  it("parses header lines", () => {
    expect(parseHeaderLines("a: 1\n-b\nbad line\n: x\nc:2")).toEqual([{ op: "set", name: "a", value: "1" }, { op: "remove", name: "b" }, { op: "set", name: "c", value: "2" }]);
  });
  it("deep merge: null deletes, no prototype pollution", () => {
    const t = { a: { b: 1, c: 2 } };
    deepMerge(t, JSON.parse("{\"a\":{\"c\":null,\"d\":3},\"__proto__\":{\"x\":1}}"));
    expect(t).toEqual({ a: { b: 1, d: 3 } });
    expect({}.x).toBeUndefined();
  });
  it("body overrides don't touch the input", () => {
    const b = { model: "m", stream: true };
    expect(applyBodyOverrides(b, { stream: "never" })).toEqual({ model: "m", stream: false });
    expect(b.stream).toBe(true);
  });
  it("query wins over the URL's own; path keeps the base", () => {
    expect(applyUrlOverrides("https://h/v1/chat/completions?api-version=1", { query: "api-version=2", path: "/x" })).toBe("https://h/v1/x?api-version=2");
  });
  it("sample request masks the key and shows what goes out", () => {
    const r = buildSampleRequest({ baseUrl: "https://h/v1", protocol: "openai-chat", model: "m1", apiKey: "sk-live-abcdefgh1234", quirks: { maxCompletionTokens: true, mimic: "codex", overrides: { body: "{bad" } } });
    expect(r.url).toBe("https://h/v1/chat/completions");
    expect(JSON.stringify(r)).not.toContain("abcdefgh");
    expect(r.headers).toContainEqual(["authorization", "Bearer sk-…1234"]);
    expect(r.headers).toContainEqual(["originator", "codex_cli_rs"]);
    expect(r.body).toMatchObject({ max_completion_tokens: 1024 });
    expect(r.jsonError).not.toBe("");
  });
});
