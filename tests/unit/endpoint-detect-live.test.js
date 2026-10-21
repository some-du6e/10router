// Add endpoint, live dialog: failure kinds, per-API check counts and the
// unasked ids, "Check the rest", the opt-in test message (beta-flag drop and
// retry), and the site name/icon reader. All upstreams are scripted.
import { describe, it, expect } from "vitest";
import { detectEndpoint, checkModels, sendTestMessage, fetchSiteInfo, parseSiteHtml, cleanSiteName, siteRoots, imageSize, readCapped } from "@/lib/endpointDetect.js";
import { parseRejectedBetas } from "../../open-sse/utils/anthropicBeta.js";

const GOOD = "pat-real-key-123456";
const keyOk = (auth) => auth.includes(GOOD);

function upstream(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const { pathname } = new URL(url);
    const auth = init.headers?.authorization || init.headers?.["x-api-key"] || "";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, pathname, auth, body, headers: init.headers });
    const handler = routes[`${init.method} ${pathname}`];
    const out = handler ? handler({ auth, body, headers: init.headers }) : [404, ""];
    if (out instanceof Error) throw out;
    const [status, resBody] = out;
    return new Response(typeof resBody === "string" ? resBody : JSON.stringify(resBody), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, calls };
}

const CATALOG = { providers: [], labs: [
  { id: "m-a", lab: "x", family: "a", date: "2026-09-01" },
  { id: "m-b", lab: "x", family: "b", date: "2026-09-01" },
  { id: "m-c", lab: "x", family: "c", date: "2026-09-01" },
  { id: "m-d", lab: "x", family: "d", date: "2026-09-01" },
  { id: "m-e", lab: "x", family: "e", date: "2026-09-01" },
  { id: "m-f", lab: "x", family: "f", date: "2026-09-01" },
] };

describe("detectEndpoint failure kinds", () => {
  it("key: every request 401", async () => {
    const no = () => [401, { error: { message: "Invalid API key", code: "invalid_api_key" } }];
    const { fetchFn } = upstream({ "GET /v1/models": no, "POST /v1/chat/completions": no, "POST /v1/messages": no, "POST /v1/responses": no });
    const r = await detectEndpoint({ url: "https://bad.example.com/v1", apiKey: "wrong-key-000000", fetchFn });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("key");
  });

  it("unreachable: stops after two unanswered requests", async () => {
    const { fetchFn, calls } = upstream({});
    const dead = async (url, init) => { calls.push(init.method); throw new Error("connect ECONNREFUSED"); };
    const r = await detectEndpoint({ url: "https://dead.example.com:8443/v1", apiKey: GOOD, fetchFn: dead });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("unreachable");
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("down: every request 503", async () => {
    const down = () => [503, { error: { message: "Service Unavailable" } }];
    const { fetchFn } = upstream({ "GET /v1/models": down, "POST /v1/chat/completions": down, "POST /v1/messages": down, "POST /v1/responses": down, "GET /models": down, "POST /chat/completions": down, "POST /messages": down, "POST /responses": down });
    const r = await detectEndpoint({ url: "https://down.example.com/v1", apiKey: GOOD, fetchFn });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("down");
  });

  it("progress events carry a short error hint, never the key", async () => {
    const events = [];
    const no = () => [401, { error: { message: `bad key ${GOOD}`, code: "invalid_api_key" } }];
    const { fetchFn } = upstream({ "GET /v1/models": no, "POST /v1/chat/completions": no, "POST /v1/messages": no, "POST /v1/responses": no });
    await detectEndpoint({ url: "https://bad.example.com/v1", apiKey: GOOD, fetchFn, onProgress: (e) => events.push(e) });
    const responses = events.filter((e) => e.type === "response");
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.some((e) => e.hint === "invalid_api_key")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(GOOD);
  });
});

describe("model checks: counts and the unasked ids", () => {
  const chat = (served, { limitAfter = Infinity } = {}) => {
    let n = 0;
    return ({ auth, body }) => {
      if (!keyOk(auth)) return [401, { error: { message: "Invalid API key" } }];
      if (!body.messages?.length && body.model === "probe") return [400, { error: { message: "messages must not be empty", type: "invalid_request_error" } }];
      if (body.model !== "10router-no-such-model" && ++n > limitAfter) return [429, { error: { message: "slow down" } }];
      return served.includes(body.model) ? [400, { error: { message: "messages must not be empty", type: "invalid_request_error" } }]
        : [404, { error: { message: `model ${body.model} not found`, code: "model_not_found" } }];
    };
  };

  it("reports checked / found / unchecked per API, and stopReason on a rate limit", async () => {
    const { fetchFn } = upstream({ "POST /v1/chat/completions": chat(["m-a", "m-c"], { limitAfter: 3 }) });
    const r = await detectEndpoint({ url: "https://gw.example.com/v1", apiKey: GOOD, fetchFn, catalog: CATALOG, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(r.stopReason).toBe("rate");
    const c = r.checks["openai-chat"];
    expect(c.total).toBe(6);
    expect(c.checked).toBeLessThan(6);
    expect(c.checked + c.unchecked.length).toBeLessThanOrEqual(6);
    expect(c.unchecked.length).toBeGreaterThan(0);
    expect(c.found).toBe(r.models.length);
  });

  it("checkModels asks only the given ids, one at a time, and finds the served ones", async () => {
    const { fetchFn, calls } = upstream({ "POST /v1/chat/completions": chat(["m-e"]) });
    const r = await checkModels({ baseUrl: "https://gw.example.com/v1", apiKey: GOOD, protocol: "openai-chat", ids: ["m-d", "m-e", "m-f"], fetchFn });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["m-e"]);
    expect(r.check).toMatchObject({ total: 3, checked: 3, found: 1, unchecked: [], stopped: null });
    const asked = calls.map((c) => c.body.model);
    expect(asked[0]).toBe("10router-no-such-model"); // canary first
    expect(asked.slice(1).sort()).toEqual(["m-d", "m-e", "m-f"]);
    for (const c of calls) expect(c.body.messages).toEqual([]); // free only
  });

  it("checkModels fails cleanly when the canary is no longer refused", async () => {
    const { fetchFn } = upstream({ "POST /v1/chat/completions": () => [401, { error: { message: "Invalid API key" } }] });
    const r = await checkModels({ baseUrl: "https://gw.example.com/v1", apiKey: GOOD, protocol: "openai-chat", ids: ["m-a"], fetchFn });
    expect(r.ok).toBe(false);
    expect(r.models).toEqual([]);
  });
});

describe("sendTestMessage", () => {
  it("drops the beta flag the endpoint rejects, retries once, reports it", async () => {
    const { fetchFn, calls } = upstream({
      "POST /v1/messages": ({ headers }) => (headers["anthropic-beta"] || "").includes("oauth-2025-04-20")
        ? [400, { message: "Unexpected value(s) `oauth-2025-04-20` for the `anthropic-beta` header. Please consult our documentation." }]
        : [200, { type: "message", content: [{ type: "text", text: "Hi" }], usage: { input_tokens: 8, output_tokens: 1 } }],
    });
    const r = await sendTestMessage({ baseUrl: "https://sf.example.com/v1", apiKey: GOOD, protocol: "anthropic", model: "claude-haiku-4-5", betas: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"], fetchFn, parseRejected: parseRejectedBetas });
    expect(r.ok).toBe(true);
    expect(r.dropped).toEqual(["oauth-2025-04-20"]);
    expect(r.sentBetas).toEqual(["interleaved-thinking-2025-05-14"]);
    expect(r.tokens).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
  });

  it("chat: one request with a 1-token cap, honouring max_completion_tokens", async () => {
    const { fetchFn, calls } = upstream({ "POST /v1/chat/completions": () => [200, { choices: [{ message: { content: "Hi" } }], usage: { completion_tokens: 1 } }] });
    const r = await sendTestMessage({ baseUrl: "https://gw.example.com/v1", apiKey: GOOD, protocol: "openai-chat", model: "m-a", quirks: { maxCompletionTokens: true }, fetchFn, parseRejected: () => [] });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.max_completion_tokens).toBe(1);
    expect(calls[0].body.max_tokens).toBeUndefined();
  });

  it("an error never echoes the key", async () => {
    const { fetchFn } = upstream({ "POST /v1/chat/completions": () => [401, { error: { message: `key ${GOOD} is revoked` } }] });
    const r = await sendTestMessage({ baseUrl: "https://gw.example.com/v1", apiKey: GOOD, protocol: "openai-chat", model: "m-a", fetchFn, parseRejected: () => [] });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain(GOOD);
  });
});

describe("site name and icon", () => {
  it("cleans titles and rejects walls", () => {
    expect(cleanSiteName("Snowflake | The AI Data Cloud")).toBe("Snowflake");
    expect(cleanSiteName("OpenRouter - A unified interface")).toBe("OpenRouter");
    expect(cleanSiteName("Just a moment...")).toBeNull();
    expect(cleanSiteName("Welcome to nginx!")).toBeNull();
  });

  it("parses og:site_name and icon links, apple-touch-icon first", () => {
    const html = `<html><head><title>Acme - Fast inference</title><meta property="og:site_name" content="Acme AI">
      <link rel="icon" href="/fav-16.png" sizes="16x16"><link rel="icon" href="/fav-64.png" sizes="64x64"><link rel="apple-touch-icon" href="/touch.png"></head></html>`;
    const info = parseSiteHtml(html, "https://acme.ai/");
    expect(info.name).toBe("Acme AI");
    expect(info.icons.map((i) => i.href)).toEqual(["https://acme.ai/touch.png", "https://acme.ai/fav-64.png", "https://acme.ai/fav-16.png"]);
  });

  it("tries the bare domain, skips LAN hosts", () => {
    expect(siteRoots("https://acme-xy12345.snowflakecomputing.com/api/v2/cortex/v1")).toEqual(["https://acme-xy12345.snowflakecomputing.com", "https://snowflakecomputing.com"]);
    expect(siteRoots("http://192.168.1.40:8000/v1")).toEqual([]);
    expect(siteRoots("http://localhost:11434/v1")).toEqual([]);
  });

  const png = (px) => {
    const b = new Uint8Array(40);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const v = new DataView(b.buffer);
    v.setUint32(16, px); v.setUint32(20, px);
    return b;
  };

  it("reads WebP sizes", () => {
    const webp = (fourcc, fill) => { const b = new Uint8Array(40); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...[...fourcc].map((c) => c.charCodeAt(0))]); fill(b); return b; };
    expect(imageSize(webp("VP8X", (b) => { b[24] = 191; b[27] = 191; }))).toBe(192);
    expect(imageSize(webp("VP8 ", (b) => { b[26] = 0; b[27] = 2; b[28] = 0; b[29] = 2; }))).toBe(512);
    expect(imageSize(webp("VP8L", (b) => { b[20] = 0x2f; const v = 255 | (255 << 14); b[21] = v & 255; b[22] = (v >> 8) & 255; b[23] = (v >> 16) & 255; b[24] = (v >>> 24) & 255; }))).toBe(256);
  });
  it("reads PNG sizes", () => {
    expect(imageSize(png(180))).toBe(180);
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  const site = (pages) => async (url) => {
    const p = pages[url];
    if (!p) return new Response("", { status: 404 });
    return new Response(p.body, { status: p.status || 200, headers: p.headers || {} });
  };

  it("copies a big-enough icon as a data URL, skipping a 16px one", async () => {
    const fetchFn = site({
      "https://api.acme.ai/": { body: "", status: 301, headers: { location: "https://acme.ai/" } },
      "https://acme.ai/": { body: `<title>Acme | Inference</title><link rel="icon" href="/small.png"><link rel="icon" href="/big.png" sizes="128x128">`, headers: { "content-type": "text/html" } },
      "https://acme.ai/big.png": { body: png(128), headers: { "content-type": "image/png" } },
      "https://acme.ai/small.png": { body: png(16), headers: { "content-type": "image/png" } },
    });
    const r = await fetchSiteInfo("https://api.acme.ai/v1", fetchFn);
    expect(r.name).toBe("Acme");
    expect(r.icon).toMatch(/^data:image\/png;base64,/);
    expect(r.host).toBe("acme.ai");
  });

  it("skips a 32px favicon on the API host for the bare domain's sharp icon", async () => {
    const fetchFn = site({
      "https://acme-xy1.snowcloud.com/": { body: "<title>Sign in</title>", headers: { "content-type": "text/html" } },
      "https://acme-xy1.snowcloud.com/favicon.ico": { body: png(32), headers: { "content-type": "image/png" } },
      "https://snowcloud.com/": { body: `<title>Snowcloud</title><link rel="apple-touch-icon" href="/touch.png">`, headers: { "content-type": "text/html" } },
      "https://snowcloud.com/touch.png": { body: png(180), headers: { "content-type": "image/png" } },
    });
    const r = await fetchSiteInfo("https://acme-xy1.snowcloud.com/api/v1", fetchFn);
    expect(r.icon).toBe(`data:image/png;base64,${Buffer.from(png(180)).toString("base64")}`);
    expect(r.host).toBe("snowcloud.com");
  });

  it("an HTML 200 for /favicon.ico is not an icon", async () => {
    const fetchFn = site({
      "https://acme.dev/": { body: "<title>Acme</title>", headers: { "content-type": "text/html" } },
      "https://acme.dev/favicon.ico": { body: "<html>not found</html>", headers: { "content-type": "text/html" } },
    });
    const r = await fetchSiteInfo("https://acme.dev/v1", fetchFn);
    expect(r).toMatchObject({ name: "Acme", icon: null });
  });

  // A body with no content-length, streamed in chunks; counts what was pulled.
  const chunked = (chunk, times) => {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream({
      pull(c) { if (state.pulled >= times) return c.close(); state.pulled++; c.enqueue(chunk); },
      cancel() { state.cancelled = true; },
    });
    return { state, body };
  };

  it("reads a body up to a byte cap, then cancels the rest", async () => {
    const { state, body } = chunked(new Uint8Array(1000), 1000);
    const r = await readCapped(new Response(body), 2500);
    expect(r).toMatchObject({ over: true });
    expect(r.bytes.length).toBe(2500);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10);
    const small = await readCapped(new Response("hello"), 100);
    expect(small).toMatchObject({ over: false });
    expect(new TextDecoder().decode(small.bytes)).toBe("hello");
  });

  it("drops a chunked icon over 256 KB without buffering it all", async () => {
    const { state, body } = chunked(new Uint8Array(64 * 1024), 100);
    const fetchFn = site({
      "https://acme.dev/": { body: "<title>Acme</title>", headers: { "content-type": "text/html" } },
      "https://acme.dev/favicon.ico": { body, headers: { "content-type": "image/x-icon" } },
    });
    const r = await fetchSiteInfo("https://acme.dev/v1", fetchFn);
    expect(r).toMatchObject({ name: "Acme", icon: null });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10);
  });

  it("cancels redirect bodies before following them", async () => {
    const { state, body } = chunked(new Uint8Array(10), 5);
    const fetchFn = site({
      "https://api.acme.ai/": { body, status: 301, headers: { location: "https://acme.ai/" } },
      "https://acme.ai/": { body: "<title>Acme</title>", headers: { "content-type": "text/html" } },
    });
    expect((await fetchSiteInfo("https://api.acme.ai/v1", fetchFn)).name).toBe("Acme");
    expect(state.cancelled).toBe(true);
  });
});
