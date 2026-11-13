import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({ connections: [] }));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => db.connections),
}));

const { getCodexUpstreamModels, resetCodexUpstreamCatalog, codexModelsUrl } = await import("@/sse/services/codexUpstreamCatalog.js");

const later = new Date(Date.now() + 3_600_000).toISOString();
const earlier = new Date(Date.now() - 60_000).toISOString();
const codexAccount = (id, extra = {}) => ({ id, provider: "codex", isActive: true, accessToken: `token-${id}`, expiresAt: later, ...extra });
const catalogResponse = (slugs) => new Response(JSON.stringify({ models: slugs.map((slug) => ({ slug })) }), { status: 200 });

let fetchMock;
beforeEach(() => {
  resetCodexUpstreamCatalog();
  db.connections = [];
  fetchMock = vi.fn(async () => catalogResponse(["gpt-5.5"]));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const tokenOf = (call) => call[1].headers.Authorization.replace(/^Bearer /, "");

describe("Codex upstream catalog", () => {
  it("returns nothing, without calling out, when no Codex account is connected", async () => {
    db.connections = [{ id: "a", provider: "claude", accessToken: "x" }];
    expect(await getCodexUpstreamModels("0.167.2")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the catalog for the asking Codex version and caches it per version", async () => {
    db.connections = [codexAccount("a")];
    expect((await getCodexUpstreamModels("0.167.2")).map((m) => m.slug)).toEqual(["gpt-5.5"]);
    await getCodexUpstreamModels("0.167.2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(codexModelsUrl("0.167.2"));

    await getCodexUpstreamModels("0.137.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("client_version=0.137.0");
  });

  it("uses its default version for a missing or malformed client_version", async () => {
    db.connections = [codexAccount("a")];
    await getCodexUpstreamModels(null);
    await getCodexUpstreamModels("1.2.3&x=y");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(codexModelsUrl());
  });

  it("skips accounts whose token has expired instead of refreshing them", async () => {
    db.connections = [codexAccount("old", { expiresAt: earlier }), codexAccount("off", { isActive: false }), codexAccount("ok")];
    await getCodexUpstreamModels("0.167.2");
    expect(fetchMock.mock.calls.map(tokenOf)).toEqual(["token-ok"]);
  });

  it("moves to the next account when one is refused, and ignores a body that isn't a catalog", async () => {
    db.connections = [codexAccount("a"), codexAccount("b"), codexAccount("c")];
    fetchMock
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    expect((await getCodexUpstreamModels("0.167.2")).map((m) => m.slug)).toEqual(["gpt-5.5"]);
    expect(fetchMock.mock.calls.map(tokenOf)).toEqual(["token-a", "token-b", "token-c"]);
  });

  it("returns nothing when every account fails, and waits before trying again", async () => {
    db.connections = [codexAccount("a")];
    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await getCodexUpstreamModels("0.167.2")).toEqual([]);
    expect(await getCodexUpstreamModels("0.167.2")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
