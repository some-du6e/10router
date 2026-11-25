import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { buildSideSearchMessage } from "../../src/sse/services/claudeSearchShortcut.js";

const { searchConfig } = REGISTRY.find((p) => p.id === "exa");
const CONFIG = { id: "exa", ...searchConfig };
const PARAMS = { query: "valkey licensing", searchType: "web", maxResults: 5, token: "exa_test_key" };
// Exa reads contents only under `contents`: the top-level text/highlights
// flags 10router used to send came back with no page text at all.
const LITE = { type: "lite", contents: { highlights: { maxCharacters: 700 } } };

const bodyOf = (params) => JSON.parse(buildSearchRequest(CONFIG, { ...PARAMS, ...params }).init.body);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Exa search request", () => {
  it("asks for the low-latency type, capped highlights under contents, and the 10 results the base price covers", () => {
    expect(bodyOf({})).toEqual({ query: "valkey licensing", numResults: 10, ...LITE });
    expect(bodyOf({ maxResults: 20 }).numResults).toBe(20);
  });

  it("keeps the domain filters and the news category on the same body", () => {
    expect(bodyOf({ domainFilter: ["github.com", "-reddit.com"], searchType: "news" })).toEqual({
      query: "valkey licensing",
      numResults: 10,
      ...LITE,
      includeDomains: ["github.com"],
      excludeDomains: ["reddit.com"],
      category: "news",
    });
  });
});

describe("Exa search results", () => {
  it("joins every highlight a result returned into its snippet, falling back to page text", () => {
    const { results } = normalizeSearchResponse("exa", {
      results: [
        { title: "A", url: "https://a.example/x", highlights: ["First excerpt.", "  ", "Second excerpt."] },
        { title: "B", url: "https://b.example/y", text: "Page text only." },
        { title: "C", url: "https://c.example/z", highlights: [] },
      ],
    }, "q", "web");
    expect(results.map((r) => r.snippet)).toEqual(["First excerpt. … Second excerpt.", "Page text only.", ""]);
  });
});

describe("Exa search end to end", () => {
  it("sends the lite body to Exa, keeps the requested count, and reports lite's base price", async () => {
    // The SSRF guard resolves the host before fetching; keep that off the network.
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const hits = Array.from({ length: 10 }, (_, i) => ({ title: `R${i}`, url: `https://r${i}.example/`, highlights: [`Excerpt ${i}.`] }));
    hits[0].highlights = ["One.", "Two."];
    const fetch = vi.fn(async () => new Response(JSON.stringify({ results: hits }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await handleSearchCore({
      body: { query: "valkey licensing" },
      provider: { id: "exa" },
      providerConfig: searchConfig,
      credentials: { apiKey: "exa_test_key" },
    });
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.headers["x-api-key"]).toBe("exa_test_key");
    expect(JSON.parse(init.body)).toEqual({ query: "valkey licensing", numResults: 10, ...LITE });

    const payload = await result.response.json();
    expect(payload.results).toHaveLength(5);
    expect(payload.results[0].snippet).toBe("One. … Two.");
    expect(payload.usage.search_cost_usd).toBe(0.004);
    const answer = buildSideSearchMessage("claude-test", "valkey licensing", payload);
    expect(JSON.stringify(answer.content)).toContain("One. … Two.");
  });
});
