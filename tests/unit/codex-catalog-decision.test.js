// The settings route's model_catalog_url decision on its real path: the
// routed list (stubbed build), the key's allowlist through keyLimits, and the
// wait for a list that reflects a provider just added.
import { describe, it, expect, vi, beforeEach } from "vitest";

const routed = vi.hoisted(() => ({ models: [], calls: 0, policy: null, delayMs: 0 }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async () => {
    routed.calls += 1;
    const models = routed.models;
    if (routed.delayMs) await new Promise((resolve) => setTimeout(resolve, routed.delayMs));
    return models;
  },
}));
vi.mock("@/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getApiKeyPolicy: async (...args) => (routed.policy ? routed.policy(...args) : null),
}));

const { decideCatalogUrl } = await import("@/lib/codex/catalogUrlDecision.js");
const { resetRoutedModels, warmRoutedModels } = await import("@/lib/codex/routedModels.js");
const { bumpConnectionsVersion } = await import("@/lib/db/repos/connectionsRepo.js");

const NEW = [0, 167, 2];
const list = (...ids) => ids.map((id) => ({ id, owned_by: id.split("/")[0] }));
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  resetRoutedModels();
  routed.models = [];
  routed.calls = 0;
  routed.policy = null;
  routed.delayMs = 0;
});

describe("model_catalog_url decision", () => {
  it("leaves the line out when the key's allowlist lookup throws", async () => {
    routed.models = list("cx/gpt-5.5");
    routed.policy = async () => { throw new Error("database is locked"); };
    expect(await decideCatalogUrl({ apiKey: "sk-some-key", ids: ["cx/gpt-5.5"], codexVersion: NEW }))
      .toEqual({ write: false, reason: "lookup-failed" });
  });

  it("writes the line when the routed list has both ids for an open key", async () => {
    routed.models = list("cx/gpt-5.5", "cc/claude-opus-5-5");
    expect(await decideCatalogUrl({ apiKey: "sk-open", ids: ["cx/gpt-5.5", "cc/claude-opus-5-5"], codexVersion: NEW }))
      .toEqual({ write: true, reason: "listed" });
  });

  it("says why for an old Codex, and for ids the key's list lacks", async () => {
    routed.models = list("cx/gpt-5.5");
    expect(await decideCatalogUrl({ apiKey: null, ids: ["cx/gpt-5.5"], codexVersion: [0, 165, 0] }))
      .toEqual({ write: false, reason: "codex-version" });
    expect(await decideCatalogUrl({ apiKey: null, ids: ["cx/gpt-5.5", "cc/claude-opus-5-5"], codexVersion: NEW }))
      .toEqual({ write: false, reason: "not-listed" });
    routed.policy = async () => ({ allowedModels: ["gpt-5.5"] });
    expect(await decideCatalogUrl({ apiKey: "sk-bare", ids: ["cx/gpt-5.5"], codexVersion: NEW }))
      .toEqual({ write: false, reason: "not-listed" });
  });

  it("waits for the list to catch up with a provider added just before Apply", async () => {
    routed.models = list("cx/gpt-5.5");
    warmRoutedModels();
    await settle();
    // A provider is added: the held list predates it, and its rebuild takes
    // longer than the catalog route's 1-second grace.
    routed.delayMs = 1_500;
    routed.models = list("cx/gpt-5.5", "newp/model-x");
    bumpConnectionsVersion();
    expect(await decideCatalogUrl({ apiKey: null, ids: ["newp/model-x"], codexVersion: NEW }))
      .toEqual({ write: true, reason: "listed" });
  });

  it("asks for the Codex version and the list at the same time", async () => {
    routed.models = list("cx/gpt-5.5");
    let resolveVersion;
    const version = new Promise((resolve) => { resolveVersion = resolve; });
    const listIds = vi.fn(async () => new Set(["cx/gpt-5.5"]));
    const decision = decideCatalogUrl({ apiKey: null, ids: ["cx/gpt-5.5"], codexVersion: version, listIds });
    await settle();
    expect(listIds).toHaveBeenCalledTimes(1);
    resolveVersion(NEW);
    expect(await decision).toEqual({ write: true, reason: "listed" });
  });
});

describe("the routed list's state", () => {
  it("is shared by two copies of the module, as the instrumentation and route bundles are", async () => {
    routed.models = list("cx/gpt-5.5");
    warmRoutedModels();
    await settle();
    expect(routed.calls).toBe(1);
    vi.resetModules();
    const second = await import("@/lib/codex/routedModels.js");
    routed.models = list("other/model");
    expect((await second.getRoutedModels()).map((m) => m.id)).toEqual(["cx/gpt-5.5"]);
    expect(routed.calls).toBe(1);
  });
});
