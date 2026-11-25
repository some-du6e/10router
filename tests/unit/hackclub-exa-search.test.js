import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  combos: [],
  accounts: {},
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("../../src/lib/localDb.js", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getCombos: async () => mocks.combos,
  getProviderConnectionById: async () => null,
  updateProviderConnection: vi.fn(),
}));
vi.mock("../../open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: () => false,
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: () => null,
  isValidApiKey: vi.fn(),
}));
vi.mock("../../src/sse/services/keyLimits.js", () => ({
  checkApiKeyLimits: async () => null,
  checkApiKeyExpiry: async () => null,
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  request: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), maskKey: (key) => key,
}));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers.js";
import { handleSearch } from "../../src/sse/handlers/search.js";
import { answerClaudeSideSearch } from "../../src/sse/services/claudeBuiltinSearch.js";
import { parseSearchModel, searchModelChoices } from "../../src/shared/utils/searchModel.ts";

const HACKCLUB_SEARCH_URL = "https://ai.hackclub.com/proxy/v1/exa/search";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const PSE_SEARCH_URL = "https://www.googleapis.com/customsearch/v1";
const JSON_TYPE = { "Content-Type": "application/json" };

const config = (id) => ({ id, ...AI_PROVIDERS[id].searchConfig });
const PARAMS = { query: "router news", searchType: "web", maxResults: 5, token: "key-1" };
const bodyOf = (request) => JSON.parse(request.init.body);

// What Exa (and the proxy, which passes it through) answers.
const EXA_RESPONSE = {
  results: [{
    title: "Router news",
    url: "https://news.example/router",
    publishedDate: "2026-11-01T00:00:00.000Z",
    highlights: ["First   passage.", "Second\npassage."],
    text: "Full page text",
  }],
  costDollars: { total: 0.004 },
};

// A fast search: Exa type instant, highlights only, no page text.
const fastBody = (query) => ({
  query,
  type: "instant",
  numResults: 5,
  contents: { highlights: { maxCharacters: 700 } },
});

// Shape of the side request Claude Code sends for its WebSearch tool.
const sideRequest = (query) => ({
  model: "cx/gpt-5.6-luna",
  stream: false,
  messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${query}` }] }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
});

const searchRequest = (body) => new Request("http://localhost/v1/search", {
  method: "POST",
  headers: JSON_TYPE,
  body: JSON.stringify(body),
});

let fetchMock;
let hackclubAnswer;

beforeEach(() => {
  mocks.combos = [];
  mocks.accounts = {
    "hackclub-exa": [{ connectionId: "hc-account", connectionName: "Hack Club", apiKey: "hc-key" }],
    exa: [{ connectionId: "exa-account", connectionName: "Exa", apiKey: "exa-key" }],
  };
  // The provider's accounts in order; one the handler excluded is skipped.
  mocks.getProviderCredentials.mockReset();
  mocks.getProviderCredentials.mockImplementation(async (provider, excluded) => {
    const account = (mocks.accounts[provider] || []).find((candidate) => !excluded.has(candidate.connectionId));
    return account ? { ...account } : null;
  });
  mocks.markAccountUnavailable.mockReset();
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 0 });
  mocks.clearAccountError.mockReset();
  hackclubAnswer = () => Response.json(EXA_RESPONSE);
  fetchMock = vi.fn(async (url) => {
    const target = String(url);
    if (target === HACKCLUB_SEARCH_URL) return hackclubAnswer();
    if (target === EXA_SEARCH_URL) return Response.json(EXA_RESPONSE);
    if (target.startsWith(`${PSE_SEARCH_URL}?`)) return Response.json({ items: [{ title: "PSE result", link: "https://pse.example/" }] });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  // fetchPublic resolves the host to refuse private addresses; answer for it.
  vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sentRequests = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url),
  headers: init.headers,
  body: init.body === undefined ? undefined : JSON.parse(init.body),
}));

describe("Hack Club AI's Exa proxy", () => {
  it("is a web search provider keyed by a Hack Club AI key", () => {
    const entry = REGISTRY.find((candidate) => candidate.id === "hackclub-exa");
    expect(entry).toMatchObject({
      category: "apikey",
      serviceKinds: ["webSearch"],
      searchConfig: {
        format: "exa",
        baseUrl: HACKCLUB_SEARCH_URL,
        method: "POST",
        authHeader: "bearer",
        validateUrl: "https://ai.hackclub.com/proxy/v1/stats",
        costPerQuery: 0,
      },
    });
    expect(AI_PROVIDERS["hackclub-exa"].searchConfig).toEqual(entry.searchConfig);
    expect(getProvidersByKind("webSearch").map((provider) => provider.id)).toContain("hackclub-exa");
  });

  it("sends Exa's own request body, authenticated with a Bearer key", () => {
    const request = buildSearchRequest(config("hackclub-exa"), { ...PARAMS, searchMode: "instant" });
    expect(request.url).toBe(HACKCLUB_SEARCH_URL);
    expect(request.init.headers).toEqual({ ...JSON_TYPE, Authorization: "Bearer key-1" });
    expect(bodyOf(request)).toEqual(bodyOf(buildSearchRequest(config("exa"), { ...PARAMS, searchMode: "instant" })));
  });

  it("reads Exa's response, credits it to the proxy and keeps every highlight", () => {
    const { results } = normalizeSearchResponse("hackclub-exa", EXA_RESPONSE, "router news", "web", "exa");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Router news",
      url: "https://news.example/router",
      snippet: "First passage. … Second passage.",
      published_at: "2026-11-01T00:00:00.000Z",
      content: { format: "text", text: "Full page text" },
      citation: { provider: "hackclub-exa", rank: 1 },
    });
  });

  it("falls back to the start of the page text for a result with no highlights", () => {
    const text = "x".repeat(400);
    const { results } = normalizeSearchResponse("exa", {
      results: [
        { title: "Text only", url: "https://a.example/", highlights: [], text },
        { title: "Nothing", url: "https://b.example/" },
      ],
    }, "q", "web");
    expect(results.map((result) => result.snippet)).toEqual(["x".repeat(300), ""]);
  });
});

describe("Exa search modes", () => {
  it("keeps Exa's searchConfig, with its modes", () => {
    expect(AI_PROVIDERS.exa.searchConfig).toEqual({
      format: "exa",
      baseUrl: EXA_SEARCH_URL,
      method: "POST",
      authType: "apikey",
      authHeader: "x-api-key",
      costPerQuery: 0.007,
      freeMonthlyQuota: 1000,
      searchTypes: ["web", "news"],
      modes: ["auto", "lite", "fast", "instant"],
      defaultMode: "auto",
      highlightMaxCharacters: 700,
      defaultMaxResults: 5,
      maxMaxResults: 100,
      timeoutMs: 10000,
      cacheTTLMs: 300000,
    });
  });

  it("keeps a bare exa on Exa's default search, with page text", () => {
    const request = buildSearchRequest(config("exa"), PARAMS);
    expect(request.url).toBe(EXA_SEARCH_URL);
    expect(request.init.headers).toEqual({ ...JSON_TYPE, "x-api-key": "key-1" });
    expect(bodyOf(request)).toEqual({
      query: "router news",
      type: "auto",
      numResults: 5,
      contents: { highlights: { maxCharacters: 700 }, text: true },
    });
  });

  it("sends the mode the model names, and no page text when only snippets are shown", () => {
    const request = buildSearchRequest(config("exa"), { ...PARAMS, searchMode: "instant", contentOptions: { full_page: false } });
    expect(bodyOf(request)).toEqual(fastBody("router news"));
  });

  it("takes the type only from the model's mode", () => {
    for (const type of ["", "auto", "deep-reasoning"]) {
      const request = buildSearchRequest(config("exa"), { ...PARAMS, searchMode: "instant", providerOptions: { type } });
      expect(bodyOf(request).type).toBe("instant");
    }
  });

  it("keeps domain filters and news searches", () => {
    const request = buildSearchRequest(config("exa"), {
      ...PARAMS, searchType: "news", searchMode: "lite", domainFilter: ["nodejs.org", "-spam.example"],
    });
    expect(bodyOf(request)).toMatchObject({
      type: "lite", includeDomains: ["nodejs.org"], excludeDomains: ["spam.example"], category: "news",
    });
  });

  it("reads a mode from the model, and none from the /v1/models id", () => {
    expect(parseSearchModel("exa/instant")).toEqual({ provider: "exa", mode: "instant" });
    expect(parseSearchModel("exa")).toEqual({ provider: "exa", mode: null });
    expect(parseSearchModel("exa/search")).toEqual({ provider: "exa", mode: null });
  });

  it("offers each mode in the model picker", () => {
    expect(searchModelChoices("exa", AI_PROVIDERS.exa).map((choice) => choice.value))
      .toEqual(["exa", "exa/lite", "exa/fast", "exa/instant"]);
    expect(searchModelChoices("hackclub-exa", AI_PROVIDERS["hackclub-exa"]).map((choice) => choice.name))
      .toContain("Hack Club AI Search · instant");
    expect(searchModelChoices("tavily", AI_PROVIDERS.tavily).map((choice) => choice.value)).toEqual(["tavily"]);
  });
});

describe("/v1/search with a mode", () => {
  it("searches with the mode the model names", async () => {
    const response = await handleSearch(searchRequest({ model: "exa/instant", query: "node release" }));
    expect(response.status).toBe(200);
    expect(sentRequests()).toEqual([{
      url: EXA_SEARCH_URL,
      headers: { ...JSON_TYPE, "x-api-key": "exa-key" },
      body: { ...fastBody("node release"), contents: { highlights: { maxCharacters: 700 }, text: true } },
    }]);
  });

  it("answers the exa/search id /v1/models lists, with Exa's default search", async () => {
    const response = await handleSearch(searchRequest({ model: "exa/search", query: "node release" }));
    expect(response.status).toBe(200);
    expect(sentRequests()[0].body.type).toBe("auto");
  });

  it("refuses a mode the provider doesn't list before picking an account", async () => {
    const refused = {};
    for (const model of ["exa/deep-reasoning", "tavily/instant", "searxng/instant"]) {
      const response = await handleSearch(searchRequest({ model, query: "node release" }));
      refused[model] = [response.status, (await response.json()).error.message];
    }
    expect(refused).toEqual({
      "exa/deep-reasoning": [400, 'Unknown search mode "deep-reasoning" for exa: use one of auto, lite, fast, instant'],
      "tavily/instant": [400, 'tavily has no search modes, so "tavily/instant" can\'t be used'],
      "searxng/instant": [400, 'searxng has no search modes, so "searxng/instant" can\'t be used'],
    });
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a query no provider can take before picking an account", async () => {
    mocks.combos = [{ name: "fast-search", kind: "webSearch", models: ["hackclub-exa/instant", "exa/instant"] }];
    for (const model of ["exa", "fast-search"]) {
      const response = await handleSearch(searchRequest({ model, query: "router\u001bnews" }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain("invalid control characters");
    }
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("locks no account for a provider option the builder refuses", async () => {
    const response = await handleSearch(searchRequest({
      model: "exa", query: "node release", provider_options: { baseUrl: "http://127.0.0.1:8080" },
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("Blocked URL");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("tries the next account when one lacks a setting the request needs", async () => {
    mocks.accounts["google-pse"] = [
      { connectionId: "pse-a", connectionName: "A", apiKey: "pse-key-a", providerSpecificData: {} },
      { connectionId: "pse-b", connectionName: "B", apiKey: "pse-key-b", providerSpecificData: { cx: "engine-b" } },
    ];
    const response = await handleSearch(searchRequest({ model: "google-pse", query: "node release" }));
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].url).toBe("https://pse.example/");
    const [sent] = sentRequests();
    expect(new URL(sent.url).searchParams.get("cx")).toBe("engine-b");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("reports the other accounts' rate limit, not one account's refusal", async () => {
    const locked = {
      allRateLimited: true,
      retryAfter: new Date(Date.now() + 30_000).toISOString(),
      retryAfterHuman: "reset after 30s",
      lastError: "Rate limit exceeded",
      lastErrorCode: 429,
    };
    mocks.getProviderCredentials.mockImplementation(async (_provider, excluded) =>
      excluded.has("pse-a") ? locked : { connectionId: "pse-a", connectionName: "A", apiKey: "pse-key-a", providerSpecificData: {} });
    const response = await handleSearch(searchRequest({ model: "google-pse", query: "node release" }));
    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toContain("Rate limit exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers at once when the refused credential has no id to exclude", async () => {
    // Like the stand-in a no-auth provider gets: no connectionId, exclusions ignored.
    mocks.getProviderCredentials.mockImplementation(async () => {
      if (mocks.getProviderCredentials.mock.calls.length > 3) throw new Error("looped over the same credential");
      return { connectionName: "stand-in", apiKey: "exa-key" };
    });
    const response = await handleSearch(searchRequest({
      model: "exa", query: "node release", provider_options: { baseUrl: "http://127.0.0.1:8080" },
    }));
    expect(response.status).toBe(400);
    expect(mocks.getProviderCredentials).toHaveBeenCalledOnce();
  });
});

describe("Claude Code's WebSearch through a Hack Club AI → Exa combo", () => {
  beforeEach(() => {
    mocks.combos = [{ name: "fast-search", kind: "webSearch", models: ["hackclub-exa/instant", "exa/instant"] }];
  });

  const sideSearch = (query) => answerClaudeSideSearch(sideRequest(query), {
    provider: "codex",
    model: "cx/gpt-5.6-luna",
    resolveSearchModel: async () => "fast-search",
    recordDetail: vi.fn(),
  });

  it("searches Hack Club AI first, with the fast request", async () => {
    const response = await sideSearch("latest router release");
    const message = await response.json();

    expect(sentRequests()).toEqual([
      { url: HACKCLUB_SEARCH_URL, headers: { ...JSON_TYPE, Authorization: "Bearer hc-key" }, body: fastBody("latest router release") },
    ]);
    expect(message.content[1].content).toEqual([
      { type: "web_search_result", title: "Router news", url: "https://news.example/router", encrypted_content: "", page_age: null },
    ]);
    expect(message.content[2].text).toContain("First passage. … Second passage.");
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("falls back to Exa's fast search when Hack Club AI is out of daily budget", async () => {
    hackclubAnswer = () => Response.json({ error: "You've reached your daily spending limit." }, { status: 402 });
    const response = await sideSearch("router release notes");
    const message = await response.json();

    expect(sentRequests()).toEqual([
      { url: HACKCLUB_SEARCH_URL, headers: { ...JSON_TYPE, Authorization: "Bearer hc-key" }, body: fastBody("router release notes") },
      { url: EXA_SEARCH_URL, headers: { ...JSON_TYPE, "x-api-key": "exa-key" }, body: fastBody("router release notes") },
    ]);
    expect(message.content[1].content.map((result) => result.url)).toEqual(["https://news.example/router"]);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "hc-account", 402, expect.stringContaining("daily spending limit"), "hackclub-exa", "websearch:hackclub-exa", null, "hc-key",
    );
  });

  it("credits a /v1/search answer through the combo to the provider that served it", async () => {
    const data = await (await handleSearch(searchRequest({ model: "fast-search", query: "router changelog" }))).json();
    expect(data.provider).toBe("hackclub-exa");
    expect(data.results[0].citation.provider).toBe("hackclub-exa");
  });
});
