import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ combos: [], connections: [] }));
vi.mock("@/lib/db/index.js", () => ({
  getCombos: async () => db.combos,
  getProviderConnections: async () => db.connections,
}));

// SEARXNG_URL is read once at import, so each case loads a fresh module.
async function loadResolver(searxngUrl) {
  vi.resetModules();
  if (searxngUrl === undefined) vi.stubEnv("SEARXNG_URL", "");
  else vi.stubEnv("SEARXNG_URL", searxngUrl);
  return (await import("../../src/sse/services/claudeBuiltinSearch.js")).resolveBuiltinSearchModel;
}

afterEach(() => {
  vi.unstubAllEnvs();
  db.combos = [];
  db.connections = [];
});

describe("resolveBuiltinSearchModel", () => {
  it("does not pick SearXNG when SEARXNG_URL was never set", async () => {
    // The live failure: Exa blocked as payg, so the lookup fell through to a
    // SearXNG at the localhost default that nobody runs.
    db.connections = [{ provider: "exa", authType: "apikey", isActive: true }];
    const resolve = await loadResolver(undefined);
    expect(await resolve(new Set(["payg", "freeTier"]))).toBeNull();
  });

  it("picks SearXNG when SEARXNG_URL is set", async () => {
    const resolve = await loadResolver("http://search.example.com/search");
    expect(await resolve(new Set(["payg"]))).toBe("searxng");
  });

  it("uses a Web Search combo even when billing would block its providers", async () => {
    db.combos = [{ name: "web-search", kind: "webSearch", models: ["exa"] }];
    db.connections = [{ provider: "exa", authType: "apikey", isActive: true }];
    const resolve = await loadResolver(undefined);
    expect(await resolve(new Set(["payg"]))).toBe("web-search");
  });
});
