import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ combos: [], connections: [] }));
vi.mock("@/lib/db/index.js", () => ({
  getCombos: async () => db.combos,
  getProviderConnections: async () => db.connections,
}));

// SEARXNG_URL is read once at import, so each case loads a fresh module.
async function loadSearch(searxngUrl = "") {
  vi.resetModules();
  vi.stubEnv("SEARXNG_URL", searxngUrl);
  return import("../../src/sse/services/claudeBuiltinSearch.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  db.combos = [];
  db.connections = [];
});

describe("resolveBuiltinSearchModel", () => {
  it("does not pick SearXNG when SEARXNG_URL was never set", async () => {
    db.connections = [{ provider: "exa", authType: "apikey", isActive: true }];
    const { resolveBuiltinSearchModel } = await loadSearch();
    expect(await resolveBuiltinSearchModel(new Set(["payg", "freeTier"]))).toBeNull();
  });

  it("does not pick a SearXNG connection when SEARXNG_URL was never set", async () => {
    db.connections = [{ provider: "searxng", authType: "none", isActive: true }];
    const { resolveBuiltinSearchModel } = await loadSearch();
    expect(await resolveBuiltinSearchModel()).toBeNull();
  });

  it("picks SearXNG when SEARXNG_URL is set", async () => {
    const { resolveBuiltinSearchModel } = await loadSearch("http://search.example.com/search");
    expect(await resolveBuiltinSearchModel(new Set(["payg"]))).toBe("searxng");
  });

  it("uses a Web Search combo even when billing would block its providers", async () => {
    db.combos = [{ name: "web-search", kind: "webSearch", models: ["exa"] }];
    db.connections = [{ provider: "exa", authType: "apikey", isActive: true }];
    const { resolveBuiltinSearchModel } = await loadSearch();
    expect(await resolveBuiltinSearchModel(new Set(["payg"]))).toBe("web-search");
  });
});

describe("warning when no search provider resolves", () => {
  const body = () => ({
    messages: [{ role: "user", content: "router news" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });

  async function warningFor(blockedBilling) {
    const { enrichClaudeBuiltinSearch } = await loadSearch();
    const log = { warn: vi.fn() };
    await enrichClaudeBuiltinSearch(body(), { provider: "ocg", log, blockedBilling });
    return log.warn.mock.calls[0][1];
  }

  it("blames billing when a provider exists but billing blocks it", async () => {
    db.connections = [{ provider: "exa", authType: "apikey", isActive: true }];
    const warning = await warningFor(new Set(["payg"]));
    expect(warning).toContain("blocked: payg");
    expect(warning).toContain("Web Search combo");
  });

  it("says nothing is configured when no provider exists, even with billing blocks", async () => {
    const warning = await warningFor(new Set(["payg"]));
    expect(warning).toContain("configured");
    expect(warning).toContain("SEARXNG_URL");
    expect(warning).not.toContain("billing");
  });
});
