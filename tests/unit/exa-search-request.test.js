import { describe, expect, it } from "vitest";

import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";

const CONFIG = { id: "exa", baseUrl: "https://api.exa.ai/search" };
const PARAMS = { query: "valkey licensing", searchType: "web", maxResults: 5, token: "exa_test_key" };

const bodyOf = (params) => JSON.parse(buildSearchRequest(CONFIG, { ...PARAMS, ...params }).init.body);

describe("Exa search request", () => {
  it("asks for the low-latency type and capped highlights under contents", () => {
    // Exa reads contents only under `contents`: top-level text/highlights
    // flags came back with no page text at all.
    expect(bodyOf({})).toEqual({
      query: "valkey licensing",
      numResults: 5,
      type: "lite",
      contents: { highlights: { maxCharacters: 700 } },
    });
  });

  it("keeps the domain filters and the news category", () => {
    const body = bodyOf({ domainFilter: ["github.com", "-reddit.com"], searchType: "news" });
    expect(body.includeDomains).toEqual(["github.com"]);
    expect(body.excludeDomains).toEqual(["reddit.com"]);
    expect(body.category).toBe("news");
    expect(body.type).toBe("lite");
  });

  it("sends the key in x-api-key", () => {
    const { url, init } = buildSearchRequest(CONFIG, PARAMS);
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.headers["x-api-key"]).toBe("exa_test_key");
  });
});

describe("Exa search results", () => {
  it("joins every highlight a result returned into its snippet", () => {
    const { results } = normalizeSearchResponse("exa", {
      results: [
        { title: "A", url: "https://a.example/x", highlights: ["First excerpt.", "  ", "Second excerpt."] },
        { title: "B", url: "https://b.example/y", text: "Page text only." },
        { title: "C", url: "https://c.example/z" },
      ],
    }, "q", "web");
    expect(results.map((r) => r.snippet)).toEqual(["First excerpt. … Second excerpt.", "Page text only.", ""]);
  });
});
