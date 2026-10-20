// "Add endpoint" detection hardening: route-404 vs model-404, 5xx, catch-all
// servers, output caps, probe volume, auth and rate limits, keys, URLs, /models
// pagination, names, DNS rebinding. Fake upstreams only, no real providers.
import http from "node:http";
import dns from "node:dns";
import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeUrl, cleanKey, makeRedactor, joinUrl, parseModelList, suggestName, detectEndpoint, discoverModels, candidateModels, recentLabModels } from "@/lib/endpointDetect.js";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import * as guard from "@/shared/utils/ssrfGuard.js";

// Real guard by default; the pinning test lets one fake public host through.
vi.mock("@/shared/utils/ssrfGuard.js", async (importActual) => {
  const real = await importActual();
  return { ...real, assertPublicUrl: vi.fn(real.assertPublicUrl), assertPublicUrlResolved: vi.fn(real.assertPublicUrlResolved) };
});

const KEY = "sk-test-0123456789abcdef";
const noSleep = async () => {};
const RECENT = "2026-09-01";
const CATALOG = { providers: [], labs: [
  { id: "llama-4-scout", lab: "meta", family: "llama", date: RECENT },
  { id: "qwen3.8-max", lab: "qwen", family: "qwen", date: RECENT },
  { id: "claude-opus-5-5", lab: "anthropic", family: "claude-opus", date: RECENT },
  { id: "gpt-6.1-sol", lab: "openai", family: "gpt-sol", date: RECENT },
] };

// Scripted upstream: handler(method, pathname, body, headers, url) -> [status, body, headers?]
function upstream(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, pathname: u.pathname, search: u.search, body, headers: init.headers });
    const [status, out, headers = {}] = handler(init.method, u.pathname, body, init.headers || {}, u) || [404, "Not Found", { "content-type": "text/plain" }];
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status, headers: { "content-type": typeof out === "string" ? "text/plain" : "application/json", ...headers } });
  };
  return { fetchFn, calls };
}
const oaiErr = (message, code) => ({ error: { message, type: "invalid_request_error", code } });

describe("1. model-not-found 404 (vLLM / Ollama) is not a missing route", () => {
  it("vLLM: /models 404 at root, canary 404 'model does not exist' still finds chat", async () => {
    const served = new Set(["llama-4-scout"]);
    const { fetchFn } = upstream((m, path, body) => {
      if (path === "/v1/chat/completions") return served.has(body.model) ? [400, oaiErr("messages: list should have at least 1 item")] : [404, { object: "error", message: `The model \`${body.model}\` does not exist.`, type: "NotFoundError", code: 404 }];
      if (path === "/v1/models") return [500, { detail: "boom" }]; // no list
    });
    const r = await detectEndpoint({ url: "http://vllm:8000/v1", apiKey: "", fetchFn, catalog: CATALOG, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.protocols).toContain("openai-chat");
    expect(r.models).toEqual(["llama-4-scout"]);
  });
  it("Ollama: 404 {error:'model \"x\" not found, try pulling it first'}", async () => {
    const { fetchFn } = upstream((m, path, body) => {
      if (path === "/v1/chat/completions") return body.model === "qwen3.8-max" ? [400, { error: { message: "messages must not be empty" } }] : [404, { error: { message: `model "${body.model}" not found, try pulling it first`, type: "api_error" } }];
    });
    const r = await detectEndpoint({ url: "localhost:11434/v1", apiKey: "", fetchFn, catalog: CATALOG, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["qwen3.8-max"]);
  });
});

describe("2. 5xx is not 'found'", () => {
  it("503 everywhere fails with a server-error message", async () => {
    const { fetchFn } = upstream(() => [503, { error: { message: "Service Unavailable" } }]);
    const r = await detectEndpoint({ url: "https://down.example.com/v1", apiKey: KEY, fetchFn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/server errors/);
  });
});

describe("3. a catch-all 400 isn't every protocol", () => {
  it("same 400 on every path including a made-up one -> not ok", async () => {
    const { fetchFn } = upstream(() => [400, { message: "Bad Request" }]);
    const r = await detectEndpoint({ url: "https://catchall.example.com/v1", apiKey: KEY, fetchFn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/answers every request the same way/);
  });
  it("catch-all server still identifies the one path with its own error shape", async () => {
    const { fetchFn } = upstream((m, path) => path === "/v1/messages"
      ? [400, { type: "error", error: { type: "invalid_request_error", message: "messages: at least one message is required" } }]
      : [400, { message: "Bad Request" }]);
    const r = await detectEndpoint({ url: "https://mixed.example.com/v1", apiKey: KEY, fetchFn, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.protocols).toEqual(["anthropic"]);
  });
});

describe("4. output is always capped, and a generating proxy stops probing", () => {
  it("every chat model probe carries max_tokens:1, or max_completion_tokens:1 after the quirk 400", async () => {
    const { fetchFn, calls } = upstream((m, path, body) => {
      if (path !== "/v1/chat/completions") return;
      if (body.max_tokens !== undefined) return [400, oaiErr("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.")];
      return body.model === "gpt-6.1-sol" ? [400, oaiErr("messages must be non-empty")] : [400, oaiErr(`The model ${body.model} does not exist`, "model_not_found")];
    });
    const r = await detectEndpoint({ url: "https://oai.example.com/v1", apiKey: KEY, fetchFn, catalog: CATALOG, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.quirks.maxCompletionTokens).toBe(true);
    expect(r.models).toEqual(["gpt-6.1-sol"]);
    for (const c of calls.filter((x) => x.method === "POST" && x.pathname.endsWith("/chat/completions"))) {
      expect(c.body.max_tokens === 1 || c.body.max_completion_tokens === 1).toBe(true);
    }
  });
  it("a 2xx with generated content on an empty body stops model probing on that path", async () => {
    const { fetchFn, calls } = upstream((m, path, body) => {
      if (path === "/v1/chat/completions") return [200, { choices: [{ message: { role: "assistant", content: "hi" } }], model: body.model }];
    });
    const r = await detectEndpoint({ url: "https://filler.example.com/v1", apiKey: KEY, fetchFn, catalog: CATALOG, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.quirks.generatesOnEmpty).toBe(true);
    expect(r.partial).toBe(true);
    const chatPosts = calls.filter((c) => c.pathname === "/v1/chat/completions");
    expect(chatPosts.length).toBe(1); // the protocol probe only, no model probes
    expect(chatPosts[0].body.max_tokens).toBe(1);
  });
});

describe("5. probe volume, auth and rate limits", () => {
  const big = { providers: [], labs: Array.from({ length: 200 }, (_, i) => ({ id: `fam${i}-model-${i % 3 + 1}`, lab: "x", family: `fam${i}`, date: RECENT })) };
  it("caps and dedupes candidates", () => {
    const { ids } = candidateModels("https://gw.example.com/v1", big);
    expect(ids.length).toBeLessThanOrEqual(40);
    expect(new Set(ids.map((x) => x.toLowerCase())).size).toBe(ids.length);
  });
  it("401 mid-probe stops at once and isn't read as 'not served'", async () => {
    let n = 0;
    const { fetchFn, calls } = upstream((m, path, body) => {
      if (path !== "/api/v2/cortex/v1/messages") return;
      if (body.model === "10router-no-such-model") return [400, { message: `unknown model "${body.model}"` }];
      if (body.model === "probe") return [400, { type: "error", error: { type: "invalid_request_error", message: "messages empty" } }];
      return ++n > 2 ? [401, { error: { message: "Invalid API key" } }] : [400, { message: "'messages' must not be empty" }];
    });
    const r = await discoverModels({ baseUrl: "https://acme.snowflakecomputing.com/api/v2/cortex/v1", apiKey: KEY, protocol: "anthropic", fetchFn, catalog: big, sleep: noSleep });
    expect(r.partial).toBe(true);
    expect(r.authRejected).toBe(true);
    expect(r.complete).toBe(false);
    expect(calls.filter((c) => c.method === "POST").length).toBeLessThan(12);
  });
  it("429 backs off (Retry-After) and retries, then stops with partial", async () => {
    const sleeps = [];
    const { fetchFn } = upstream((m, path, body) => {
      if (path !== "/v1/messages") return;
      if (body.model === "10router-no-such-model") return [400, { message: `unknown model "${body.model}"` }];
      return [429, { error: { message: "rate limited" } }, { "retry-after": "2" }];
    });
    const r = await discoverModels({ baseUrl: "https://rl.example.com/v1", apiKey: KEY, protocol: "anthropic", fetchFn, catalog: CATALOG, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps[0]).toBe(2000);
    expect(r.partial).toBe(true);
    expect(r.partialReason).toMatch(/rate-limit/);
    expect(r.complete).toBe(false);
  });
  it("two-path discovery reports allComplete false when stopped early", async () => {
    const { fetchFn } = upstream((m, path, body) => {
      if (body?.model === "10router-no-such-model") return [400, { message: `unknown model "${body.model}"` }];
      if (m === "POST") return [401, { error: { message: "Invalid API key" } }];
    });
    const r = await discoverModels({ baseUrl: "https://two.example.com/v1", apiKey: KEY, protocol: "anthropic", protocols: ["anthropic", "openai-chat"], fetchFn, catalog: CATALOG, sleep: noSleep });
    expect(r.allComplete).toBe(false);
    expect(r.partial).toBe(true);
  });
});

describe("6. key failures need an API-shaped auth error", () => {
  it("an HTML 403 (WAF) does not blame the key", async () => {
    const { fetchFn } = upstream(() => [403, "<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head></html>", { "content-type": "text/html" }]);
    const r = await detectEndpoint({ url: "https://waf.example.com/v1", apiKey: KEY, fetchFn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.authRejected).toBe(false);
    expect(r.error).toMatch(/isn't an API response.*Cloudflare/);
  });
  it("Gemini's 400 API_KEY_INVALID is an auth failure, not 'it works'", async () => {
    const gem = [400, [{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }]];
    const { fetchFn } = upstream(() => gem);
    const r = await detectEndpoint({ url: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: KEY, fetchFn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.authRejected).toBe(true);
  });
});

describe("7. keys and redaction", () => {
  it.each([
    ["​sk-abc123﻿", "sk-abc123"],
    ["“sk-abc123”", "sk-abc123"],
    ["'Bearer sk-abc123'", "sk-abc123"],
    ["Authorization: Bearer sk-abc123", "sk-abc123"],
    ["  \"sk-abc\n123\"  ", "sk-abc123"],
  ])("cleanKey(%j)", (raw, out) => expect(cleanKey(raw)).toBe(out));
  it("a short key doesn't garble previews; query-string secrets are redacted", () => {
    const red = makeRedactor("ab1");
    expect(red("label cab1x and ab1 here")).toBe("label cab1x and <key> here");
    expect(red("https://h/v1/models?key=SECRET123&x=1")).toBe("https://h/v1/models?key=<redacted>&x=1");
  });
  it("step urls are redacted", async () => {
    const { fetchFn } = upstream(() => [400, { error: { message: "nope" } }]);
    const r = await detectEndpoint({ url: `https://q.example.com/v1?key=${KEY}`, apiKey: KEY, fetchFn, sleep: noSleep });
    expect(JSON.stringify(r.steps)).not.toContain(KEY);
  });
});

describe("8. URLs", () => {
  it("keeps ?api-version= after the path", () => {
    expect(joinUrl("https://x.openai.azure.com/openai/v1?api-version=2024-10-01", "/models")).toBe("https://x.openai.azure.com/openai/v1/models?api-version=2024-10-01");
  });
  it.each([
    ["192.168.1.5:8000/v1", "http://192.168.1.5:8000/v1"],
    ["10.0.0.2/v1", "http://10.0.0.2/v1"],
    ["172.20.0.3:11434", "http://172.20.0.3:11434"],
    ["172.32.0.3", "https://172.32.0.3"],
    ["ollama:11434/v1", "http://ollama:11434/v1"],
    ["gpu-box.local:8080/v1", "http://gpu-box.local:8080/v1"],
    ["api.example.com/v1", "https://api.example.com/v1"],
  ])("%s -> %s", (input, out) => expect(normalizeUrl(input)).toBe(out));
  it("Azure: probes keep api-version and fall back to the api-key header", async () => {
    const { fetchFn, calls } = upstream((m, path, body, headers, u) => {
      if (!headers["api-key"]) return [401, { error: { code: "401", message: "Access denied due to invalid subscription key or wrong API endpoint." } }];
      if (path === "/openai/v1/models") return [200, { data: [{ id: "gpt-6.1-sol" }, { id: "text-embedding-3-large" }] }];
      if (path === "/openai/v1/chat/completions") return [400, oaiErr("messages is empty")];
    });
    const r = await detectEndpoint({ url: "https://acme.openai.azure.com/openai/v1?api-version=2024-10-01", apiKey: KEY, fetchFn, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["gpt-6.1-sol"]);
    expect(r.quirks.apiKeyHeader).toBe(true);
    for (const c of calls) expect(c.search).toContain("api-version=2024-10-01");
  });
});

describe("10. /models", () => {
  it("follows has_more/last_id pages and drops non-chat models", async () => {
    const { fetchFn, calls } = upstream((m, path, body, h, u) => {
      if (path === "/v1/models") {
        const after = u.searchParams.get("after_id");
        if (!after) return [200, { data: [{ id: "claude-opus-5-5" }], has_more: true, last_id: "claude-opus-5-5" }];
        return [200, { data: [{ id: "claude-haiku-4-5" }, { id: "voyage-embed-3", type: "embedding" }], has_more: false }];
      }
      if (path === "/v1/messages") return [400, { type: "error", error: { type: "invalid_request_error", message: "messages: empty" } }];
    });
    const r = await detectEndpoint({ url: "https://api.anthropic.example.com/v1", apiKey: KEY, fetchFn, sleep: noSleep });
    expect(r.models).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);
    expect(calls.filter((c) => c.pathname === "/v1/models").length).toBe(2);
  });
  it("parseModelList excludes embedding / tts / image models", () => {
    expect(parseModelList({ data: ["gpt-6", "text-embedding-3-small", "tts-1", "gpt-image-1", "whisper-1", "dall-e-3"].map((id) => ({ id })) })).toEqual(["gpt-6"]);
  });
  it("keeps catalog ids that only exist dated; drops snapshots with an alias", () => {
    const labs = [
      { id: "mistral-large-2411", lab: "m", family: "ml", date: RECENT },
      { id: "gpt-6", lab: "o", family: "g", date: RECENT }, { id: "gpt-6-2026-08-01", lab: "o", family: "g", date: RECENT },
      { id: "gemini-3-vision", lab: "g", family: "gv", date: RECENT },
    ];
    expect(recentLabModels(labs, 3, 365, Date.parse("2026-10-19")).sort()).toEqual(["gemini-3-vision", "gpt-6", "mistral-large-2411"]);
  });
});

describe("11. suggestName", () => {
  it.each([
    ["https://api.foo.co.uk/v1", "Foo"],
    ["https://llm.acme.com.au/v1", "Acme"],
    ["https://api.xn--mnchen-3ya.de/v1", "München"],
    ["https://api.together.xyz/v1", "Together"],
    ["http://ollama:11434/v1", "Local endpoint"],
  ])("%s -> %s", (u, name) => expect(suggestName(u)).toBe(name));
});

describe("12. revoked key on an endpoint without /models", () => {
  it("probe 400 passes but model checks get 401: surface auth failure", async () => {
    const { fetchFn } = upstream((m, path, body) => {
      if (path !== "/v1/chat/completions") return;
      if (body.model === "probe") return [400, oaiErr("messages must not be empty")];
      return [401, oaiErr("Your API key has been revoked")];
    });
    const r = await detectEndpoint({ url: "https://revoked.example.com/v1", apiKey: KEY, fetchFn, catalog: CATALOG, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.authRejected).toBe(true);
    expect(r.models).toEqual([]);
  });
});

describe("9. probeFetch pins the checked address (DNS rebinding)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("rejects when the second resolution turns private", async () => {
    let n = 0;
    vi.spyOn(dns.promises, "lookup").mockImplementation(async () => (n++ === 0 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]));
    const fetchImpl = vi.fn();
    await expect(makeProbeFetch(true, { fetchImpl })("http://rebind.example.com/v1/models", { method: "GET" })).rejects.toThrow(/Blocked/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("connects to the resolved IP, not whatever DNS says at connect time", async () => {
    const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ host: req.headers.host })); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    // pinned.invalid can never resolve for real, so reaching the server proves
    // the connect used the pinned lookup. The guard is waved through because the
    // only server a test can reach is on loopback.
    guard.assertPublicUrl.mockImplementation(() => {});
    guard.assertPublicUrlResolved.mockImplementation(async () => {});
    try {
      const lookups = vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const res = await makeProbeFetch(true)(`http://pinned.invalid:${port}/v1/models`, { method: "GET" });
      expect((await res.json()).host).toBe(`pinned.invalid:${port}`);
      expect(lookups).toHaveBeenCalledWith("pinned.invalid", { all: true, verbatim: true });
    } finally {
      guard.assertPublicUrl.mockReset();
      guard.assertPublicUrlResolved.mockReset();
      server.close();
    }
  });
});
