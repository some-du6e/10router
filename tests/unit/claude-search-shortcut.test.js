import { describe, expect, it, vi } from "vitest";
import { getSideSearchQuery, buildSideSearchMessage } from "../../src/sse/services/claudeSearchShortcut.ts";
import { answerClaudeSideSearch } from "../../src/sse/services/claudeBuiltinSearch.js";

// Shape of the side request Claude Code 2.1.x sends for its WebSearch tool.
const sideRequest = (overrides = {}) => ({
  model: "cx/gpt-5.6-luna",
  stream: true,
  max_tokens: 32000,
  messages: [{ role: "user", content: [{ type: "text", text: "Perform a web search for the query: latest node release" }] }],
  tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["nodejs.org"], max_uses: 8 }],
  tool_choice: { type: "tool", name: "web_search" },
  ...overrides,
});

const results = { results: [{ title: "Node v26", url: "https://nodejs.org/en/blog/release/v26.12.0", snippet: "Node.js 26.12.0 released" }] };

async function readSse(response) {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\ndata: ")[1]));
}

describe("getSideSearchQuery", () => {
  it("extracts the query from Claude Code's side request", () => {
    expect(getSideSearchQuery(sideRequest())).toBe("latest node release");
  });

  it("ignores ordinary turns that also carry other tools", () => {
    const body = sideRequest({ tools: [...sideRequest().tools, { name: "Read", input_schema: {} }] });
    expect(getSideSearchQuery(body)).toBeNull();
  });

  it("ignores multi-message conversations", () => {
    const body = sideRequest();
    body.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "again" });
    expect(getSideSearchQuery(body)).toBeNull();
  });

  it("accepts a forced web_search call without the prefix", () => {
    const body = sideRequest({ messages: [{ role: "user", content: "router news" }] });
    expect(getSideSearchQuery(body)).toBe("router news");
    delete body.tool_choice;
    expect(getSideSearchQuery(body)).toBeNull();
  });
});

describe("answerClaudeSideSearch", () => {
  it("answers without calling the model and streams real web_search blocks", async () => {
    const search = vi.fn().mockResolvedValue(results);
    const response = await answerClaudeSideSearch(sideRequest(), {
      provider: "codex", model: "cx/gpt-5.6-luna", search, resolveSearchModel: async () => "exa",
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      model: "exa",
      searchRequest: expect.objectContaining({ query: "latest node release", allowedDomains: ["nodejs.org"] }),
    }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = await readSse(response);
    const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.content_block);
    expect(starts.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    expect(starts[1].tool_use_id).toBe(starts[0].id);
    expect(starts[1].content[0]).toMatchObject({ type: "web_search_result", url: "https://nodejs.org/en/blog/release/v26.12.0" });
    const text = events.find((e) => e.delta?.type === "text_delta").delta.text;
    expect(text).toContain("Node.js 26.12.0 released");
    expect(events.at(-1).type).toBe("message_stop");
  });

  it("returns JSON for non-streaming requests", async () => {
    const response = await answerClaudeSideSearch(sideRequest({ stream: false }), {
      provider: "codex", search: async () => results, resolveSearchModel: async () => "exa",
    });
    const message = await response.json();
    expect(message.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
  });

  it("reports a search error in the tool result instead of failing the turn", async () => {
    const response = await answerClaudeSideSearch(sideRequest({ stream: false }), {
      provider: "codex", search: async () => { throw new Error("boom"); }, resolveSearchModel: async () => "exa",
    });
    const message = await response.json();
    expect(message.content[1].content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" });
  });

  it("falls through when no search provider is configured", async () => {
    const search = vi.fn();
    expect(await answerClaudeSideSearch(sideRequest(), { provider: "codex", search, resolveSearchModel: async () => null })).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it("leaves native Claude upstreams alone", async () => {
    expect(await answerClaudeSideSearch(sideRequest(), { provider: "claude", search: vi.fn() })).toBeNull();
  });
});

describe("buildSideSearchMessage", () => {
  it("skips results without a url in the tool result", () => {
    const message = buildSideSearchMessage("m", "q", { results: [{ title: "no link" }, results.results[0]] });
    expect(message.content[1].content).toHaveLength(1);
  });
});
