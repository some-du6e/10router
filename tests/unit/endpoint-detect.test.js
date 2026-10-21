// "Add endpoint" detection: URL cleanup, model-list parsing, and the free-probe
// decision table. The Snowflake fixture mirrors real responses (2026-10-19).
import { describe, it, expect } from "vitest";
import { normalizeUrl, cleanKey, parseModelList, makePrefix, suggestName, detectEndpoint, discoverModels, matchCatalogProvider, majorVersion, recentLabModels, candidateModels, outdatedModels } from "@/lib/endpointDetect.js";

// Shape of the models.dev index the catalog sync writes: providers + lab models.
const PROVIDERS = [
  { id: "snowflake-cortex", name: "Snowflake Cortex", api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1", models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"] },
  { id: "openrouter", name: "OpenRouter", api: "https://openrouter.ai/api/v1", models: ["anthropic/claude-haiku-4-5", "openai/gpt-5"] },
  { id: "together", name: "Together", api: "https://api.together.xyz/v1", models: ["openai/gpt-5", "meta/llama-4"] },
];
const RECENT = "2026-09-01";
const LABS = [
  { id: "claude-opus-5-5", lab: "anthropic", family: "claude-opus", date: RECENT },
  { id: "claude-opus-4-8", lab: "anthropic", family: "claude-opus", date: "2026-03-01" },
  { id: "gpt-6.1-sol", lab: "openai", family: "gpt-sol", date: RECENT },
  { id: "gpt-6-sol", lab: "openai", family: "gpt-sol", date: "2026-07-01" },
  { id: "kimi-k3", lab: "moonshotai", family: "kimi-k3", date: RECENT },
];
const CATALOG = { providers: PROVIDERS, labs: LABS };

describe("normalizeUrl", () => {
  it.each([
    ["api.example.com/v1/", "https://api.example.com/v1"],
    ["  https://api.example.com/v1/chat/completions ", "https://api.example.com/v1"],
    ["https://x.snowflakecomputing.com/api/v2/cortex/v1/messages", "https://x.snowflakecomputing.com/api/v2/cortex/v1"],
    ["https://gw.example.com/openai/v1/models", "https://gw.example.com/openai/v1"],
    ["https://az.example.com/openai/v1/chat/completions?api-version=2024-10-01", "https://az.example.com/openai/v1?api-version=2024-10-01"],
    ["localhost:11434/v1", "http://localhost:11434/v1"],
  ])("%s → %s", (input, out) => expect(normalizeUrl(input)).toBe(out));
  it("rejects garbage", () => expect(normalizeUrl("")).toBeNull());
});

describe("cleanKey", () => {
  it("strips Bearer, quotes and whitespace", () => {
    expect(cleanKey(' "Bearer sk-abc\n123" ')).toBe("sk-abc123");
  });
});

describe("parseModelList", () => {
  it("reads OpenAI, Gemini, bare-array and string shapes", () => {
    expect(parseModelList({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] })).toEqual(["a", "b"]);
    expect(parseModelList({ models: [{ name: "models/gemini-x" }] })).toEqual(["gemini-x"]);
    expect(parseModelList([{ id: "x" }])).toEqual(["x"]);
    expect(parseModelList(["s1", "s2"])).toEqual(["s1", "s2"]);
    expect(parseModelList({ nope: 1 })).toEqual([]);
  });
});

describe("names and prefixes", () => {
  it("builds prefixes from the name", () => {
    expect(makePrefix("OpenRouter")).toBe("or");
    expect(makePrefix("Acme AI Gateway")).toBe("aag");
    expect(makePrefix("Snowflake")).toBe("snow");
    expect(makePrefix("Snowflake", ["snow"])).toBe("snow2");
  });
  it("suggests a name from the host", () => {
    expect(suggestName("https://api.together.xyz/v1")).toBe("Together");
    expect(suggestName("http://localhost:1234/v1")).toBe("Local endpoint");
  });
});

describe("catalog matching", () => {
  it("matches a templated API URL to the user's host", () => {
    expect(matchCatalogProvider("https://acme-xy1.snowflakecomputing.com/api/v2/cortex/v1", PROVIDERS)?.id).toBe("snowflake-cortex");
    expect(matchCatalogProvider("https://openrouter.ai/api/v1", PROVIDERS)?.id).toBe("openrouter");
    expect(matchCatalogProvider("https://unknown.example.com/v1", PROVIDERS)).toBeNull();
  });
});

describe("majorVersion", () => {
  it.each([
    ["claude-opus-4-8", false, 4],
    ["claude-opus-5-5", false, 5],
    ["gpt-6.1-sol", false, 6],
    ["o4-mini", false, 4],
    ["qwen3.8-max", false, 3],
    ["qwen3.8-max", true, 3.8],
    ["qwen2-5-72b-instruct", true, 2.5],
    ["kimi-k2.6", false, 2],
    ["qwen-max", false, 0],
  ])("%s (decimal=%s) → %s", (id, decimal, out) => expect(majorVersion(id, decimal)).toBe(out));
});

describe("recentLabModels", () => {
  const NOW = Date.parse("2026-10-19");
  const m = (id, family, date, lab = "x") => ({ id, lab, family, date });

  it("keeps the last 3 generations of a family", () => {
    const labs = [5, 4, 3, 2, 1].map((v) => m(`claude-opus-${v}`, "claude-opus", `2026-0${v}-01`));
    expect(recentLabModels(labs, 3, 365, NOW).sort()).toEqual(["claude-opus-3", "claude-opus-4", "claude-opus-5"]);
  });

  it("uses decimal generations when the major barely moves (qwen3.x)", () => {
    const labs = ["qwen3.8-max", "qwen3.7-max", "qwen3.6-flash", "qwen3.5-plus", "qwen2-5-72b-instruct"].map((id) => m(id, "qwen", "2026-09-01"));
    expect(recentLabModels(labs, 3, 365, NOW).sort()).toEqual(["qwen3.6-flash", "qwen3.7-max", "qwen3.8-max"]);
  });

  it("keeps versionless aliases, drops snapshots that have an alias, and stale families", () => {
    const labs = [
      m("qwen-max", "qwen", "2026-09-01"), m("qwen3.8-max", "qwen", "2026-09-01"),
      m("claude-haiku-4-5", "claude-haiku", "2026-09-01"), m("claude-haiku-4-5-20251001", "claude-haiku", "2026-09-01"),
      m("old-model-2", "old", "2024-01-01"),
    ];
    expect(recentLabModels(labs, 3, 365, NOW).sort()).toEqual(["claude-haiku-4-5", "qwen-max", "qwen3.8-max"]);
  });
});

describe("candidateModels", () => {
  it("adds the gateway's own vendor prefix (Snowflake: openai-*)", () => {
    const catalog = {
      providers: [{ id: "snowflake-cortex", name: "Snowflake Cortex", api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1", models: ["claude-haiku-4-5", "openai-gpt-5"] }],
      labs: LABS,
    };
    const { matched, ids } = candidateModels("https://acme.snowflakecomputing.com/api/v2/cortex/v1", catalog);
    expect(matched.id).toBe("snowflake-cortex");
    expect(ids.slice(0, 2)).toEqual(["claude-haiku-4-5", "openai-gpt-5"]); // its own list first
    expect(ids).toContain("openai-gpt-6-sol");
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).not.toContain("openai-claude-opus-5-5");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves out old releases the gateway's catalog still lists, and tries new ones prefixed and bare", () => {
    const labs = [...LABS,
      { id: "claude-opus-5", lab: "anthropic", family: "claude-opus", date: "2026-07-01" },
      { id: "claude-opus-4-5", lab: "anthropic", family: "claude-opus", date: "2025-11-24" },
      { id: "gpt-4.1", lab: "openai", family: "gpt", date: "2025-04-14" },
      { id: "gpt-5.5", lab: "openai", family: "gpt", date: "2026-04-23" },
      { id: "gpt-5.4", lab: "openai", family: "gpt", date: "2026-03-05" },
      { id: "gpt-5.2", lab: "openai", family: "gpt", date: "2025-12-11" },
    ];
    const catalog = { providers: [{ id: "snowflake-cortex", name: "Snowflake Cortex", api: "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1", models: ["claude-opus-4-5", "openai-gpt-4.1", "openai-gpt-5.5", "deepseek-r1", "mistral-large2"] }], labs };
    const { ids } = candidateModels("https://acme.snowflakecomputing.com/api/v2/cortex/v1", catalog);
    expect(ids).not.toContain("claude-opus-4-5");
    expect(ids).not.toContain("openai-gpt-4.1");
    expect(ids.slice(0, 3)).toEqual(["openai-gpt-5.5", "deepseek-r1", "mistral-large2"]); // not in the labs: kept
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-5-5", "openai-gpt-6.1-sol", "gpt-6.1-sol", "kimi-k3"]));
    expect(ids).not.toContain("deepseek-kimi-k3"); // "deepseek-r1" is a model, not a prefix
    expect(outdatedModels(["claude-opus-4-5", "openai-gpt-4.1", "claude-opus-5-5", "mistral-large2"], catalog)).toEqual(["claude-opus-4-5", "openai-gpt-4.1"]);
  });

  it("an unknown gateway still gets the latest lab models", () => {
    const { matched, ids } = candidateModels("https://gw.example.com/v1", CATALOG);
    expect(matched).toBeNull();
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-5-5", "gpt-6.1-sol", "kimi-k3"]));
  });
});

// Scripted upstream: route on method + path, record every call.
function upstream(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const { pathname } = new URL(url);
    const auth = init.headers?.authorization || init.headers?.["x-api-key"] || "";
    calls.push({ method: init.method, pathname, auth, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[`${init.method} ${pathname}`];
    const [status, body] = handler ? handler({ auth, body: init.body ? JSON.parse(init.body) : null }) : [404, ""];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, calls };
}

const GOOD = "pat-real-key";
const keyOk = (auth) => auth.includes(GOOD);

describe("detectEndpoint", () => {
  it("Snowflake: no /models, Anthropic found, key confirmed, catalog models confirmed for free", async () => {
    const known = new Set(["claude-sonnet-4-5", "claude-haiku-4-5"]); // claude-opus-4-1 is in the catalog but not served
    const { fetchFn, calls } = upstream({
      "POST /api/v2/cortex/v1/messages": ({ auth, body }) => !keyOk(auth) ? [401, { message: "Invalid OAuth access token. null" }]
        : known.has(body.model) ? [400, { message: "'messages' must not be empty" }] : [400, { message: `unknown model "${body.model}"` }],
      "POST /api/v2/cortex/v1/chat/completions": ({ auth }) => keyOk(auth) ? [400, { message: "max_tokens is deprecated in favor of max_completion_tokens" }] : [401, {}],
    });
    const r = await detectEndpoint({ url: "https://acme.snowflakecomputing.com/api/v2/cortex", apiKey: GOOD, fetchFn, catalog: CATALOG });
    expect(r.ok).toBe(true);
    expect(r.protocol).toBe("anthropic");
    expect(r.protocols).toContain("openai-chat");
    expect(r.baseUrl).toBe("https://acme.snowflakecomputing.com/api/v2/cortex/v1");
    expect(r.keyConfirmed).toBe("confirmed");
    expect(r.modelsSource).toBe("catalog");
    expect(r.models).toEqual(["claude-sonnet-4-5", "claude-haiku-4-5"]);
    expect(r.suggestedName).toBe("Snowflake Cortex");
    expect(r.quirks.maxCompletionTokens).toBe(true);
    // Free only: every chat probe carried an empty messages array.
    for (const c of calls.filter((x) => x.method === "POST")) {
      expect(c.body.messages ?? c.body.input).toEqual([]);
    }
  });

  it("OpenAI-style gateway with a model list", async () => {
    const { fetchFn } = upstream({
      "GET /api/v1/models": () => [200, { data: [{ id: "openai/gpt-5" }, { id: "anthropic/claude-sonnet-5" }] }],
      "POST /api/v1/chat/completions": ({ auth }) => keyOk(auth) ? [400, { error: { message: "messages: empty" } }] : [401, { error: "No auth credentials found" }],
    });
    const r = await detectEndpoint({ url: "https://openrouter.ai/api/v1/chat/completions", apiKey: GOOD, fetchFn });
    expect(r.ok).toBe(true);
    expect(r.protocol).toBe("openai-chat");
    expect(r.models).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-5"]);
    expect(r.modelsSource).toBe("models");
    expect(r.keyConfirmed).toBe("confirmed");
    expect(r.suggestedPrefix).toBe("open");
  });

  it("reports a rejected key instead of claiming it works", async () => {
    const { fetchFn } = upstream({
      "GET /v1/models": () => [401, { error: "invalid api key" }],
      "POST /v1/chat/completions": () => [401, { error: "invalid api key" }],
      "POST /v1/messages": () => [401, { error: "invalid api key" }],
      "POST /v1/responses": () => [401, { error: "invalid api key" }],
    });
    const r = await detectEndpoint({ url: "https://dead.example.com/v1", apiKey: "nope", fetchFn });
    expect(r.ok).toBe(false);
    expect(r.authRejected).toBe(true);
    expect(r.error).toMatch(/key was rejected/);
  });

  it("recognises a client gate (AgentRouter) rather than blaming the key", async () => {
    const gate = () => [401, { error: { message: "unauthorized client detected", type: "unauthorized_client_error" } }];
    const { fetchFn } = upstream({ "GET /v1/models": gate, "POST /v1/chat/completions": gate, "POST /v1/messages": gate, "POST /v1/responses": gate });
    const r = await detectEndpoint({ url: "https://agentrouter.example/v1", apiKey: GOOD, fetchFn });
    expect(r.ok).toBe(false);
    expect(r.clientGated).toBe(true);
  });

  it("says when it got a web page instead of an API", async () => {
    const page = () => [200, "<!doctype html><html><head><title>Just a moment...</title></head></html>"];
    const { fetchFn } = upstream({ "GET /v1/models": page, "POST /v1/chat/completions": page, "POST /v1/messages": page, "POST /v1/responses": page });
    const r = await detectEndpoint({ url: "https://cf.example.com/v1", apiKey: GOOD, fetchFn });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't an API response/);
  });

  it("doesn't trust model probes when made-up ids get the same answer", async () => {
    const { fetchFn } = upstream({ "POST /v1/messages": ({ auth }) => keyOk(auth) ? [400, { message: "messages: at least one message is required" }] : [401, {}] });
    const r = await detectEndpoint({ url: "https://lax.example.com/v1", apiKey: GOOD, fetchFn, catalog: CATALOG });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual([]);
    expect(r.modelsSource).toBe("none");
  });

  it("never puts the key in the evidence", async () => {
    const { fetchFn } = upstream({ "POST /v1/chat/completions": ({ auth }) => [400, { error: `bad request for key ${auth}` }] });
    const r = await detectEndpoint({ url: "https://echo.example.com/v1", apiKey: GOOD, fetchFn });
    expect(JSON.stringify(r)).not.toContain(GOOD);
  });
});

describe("discoverModels (Import models button)", () => {
  it("uses /models when the endpoint has one", async () => {
    const { fetchFn } = upstream({ "GET /v1/models": () => [200, { data: [{ id: "a" }, { id: "b" }] }] });
    const r = await discoverModels({ baseUrl: "https://gw.example.com/v1", apiKey: GOOD, protocol: "openai-chat", fetchFn, catalog: CATALOG });
    expect(r).toMatchObject({ models: ["a", "b"], source: "models" });
  });

  it("falls back to the catalog probe when there's no /models (Snowflake)", async () => {
    const known = new Set(["claude-haiku-4-5"]);
    const { fetchFn, calls } = upstream({
      "POST /api/v2/cortex/v1/messages": ({ body }) => known.has(body.model) ? [400, { message: "'messages' must not be empty" }] : [400, { message: `unknown model "${body.model}"` }],
    });
    const r = await discoverModels({ baseUrl: "https://acme.snowflakecomputing.com/api/v2/cortex/v1", apiKey: GOOD, protocol: "anthropic", fetchFn, catalog: CATALOG });
    expect(r).toMatchObject({ models: ["claude-haiku-4-5"], source: "catalog", catalogName: "Snowflake Cortex" });
    for (const c of calls.filter((x) => x.method === "POST")) expect(c.body.messages).toEqual([]);
  });


  it("marks two-path discovery incomplete when a path errors mid-probe, so routes aren't saved", async () => {
    const msg = ({ body }) => body.model === "claude-haiku-4-5" ? [400, { message: "'messages' must not be empty" }] : [400, { message: `unknown model "${body.model}"` }];
    const chatDown = ({ body }) => body.model === "10router-no-such-model" ? [400, { message: `unknown model "${body.model}"` }] : [503, { message: "upstream busy" }];
    const { fetchFn } = upstream({ "POST /api/v2/cortex/v1/messages": msg, "POST /api/v2/cortex/v1/chat/completions": chatDown });
    const r = await discoverModels({ baseUrl: "https://acme.snowflakecomputing.com/api/v2/cortex/v1", apiKey: GOOD, protocol: "anthropic", protocols: ["anthropic", "openai-chat"], fetchFn, catalog: CATALOG });
    expect(r.complete).toEqual({ anthropic: true, "openai-chat": false });
    expect(r.allComplete).toBe(false);
  });

  it("counts an empty but finished path as complete", async () => {
    const unknown = ({ body }) => [400, { message: `unknown model "${body.model}"` }];
    const { fetchFn } = upstream({ "POST /api/v2/cortex/v1/messages": unknown, "POST /api/v2/cortex/v1/chat/completions": unknown });
    const r = await discoverModels({ baseUrl: "https://acme.snowflakecomputing.com/api/v2/cortex/v1", apiKey: GOOD, protocol: "anthropic", protocols: ["anthropic", "openai-chat"], fetchFn, catalog: CATALOG });
    expect(r.allComplete).toBe(true);
    expect(r.models).toEqual([]);
  });
});
