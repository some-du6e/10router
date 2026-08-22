import { describe, expect, it, vi } from "vitest";
import { enrichClaudeBuiltinSearch, getBuiltinSearchRequest } from "../../src/sse/services/claudeBuiltinSearch.js";

const requestBody = () => ({
  model: "ocg/glm-5.2",
  system: "You are Claude Code.",
  messages: [{ role: "user", content: [{ type: "text", text: "latest router news" }] }],
  tools: [
    { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    { name: "Read", input_schema: { type: "object" } },
  ],
});

describe("Claude built-in web search on non-Claude providers", () => {
  it("extracts the query and bounded result count", () => {
    expect(getBuiltinSearchRequest(requestBody())).toEqual({
      query: "latest router news",
      maxResults: 3,
      allowedDomains: undefined,
      blockedDomains: undefined,
    });
  });

  it("injects gateway results and preserves ordinary tools", async () => {
    const search = vi.fn().mockResolvedValue({
      results: [{ title: "10router", url: "https://example.com/10router", snippet: "Routing news" }],
    });
    const body = requestBody();
    const enriched = await enrichClaudeBuiltinSearch(body, {
      provider: "ocg",
      search,
      resolveSearchModel: async () => "exa",
    });

    expect(search).toHaveBeenCalledOnce();
    expect(enriched.tools).toEqual([{ name: "Read", input_schema: { type: "object" } }]);
    expect(enriched.system.at(-1).text).toContain("https://example.com/10router");
    expect(body.tools).toHaveLength(2);
  });

  it("leaves native Claude requests untouched", async () => {
    const body = requestBody();
    const search = vi.fn();
    expect(await enrichClaudeBuiltinSearch(body, { provider: "claude", search })).toBe(body);
    expect(search).not.toHaveBeenCalled();
  });
});
