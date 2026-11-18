// The settings route's model_catalog_url decision on its real path: the
// routed list (stubbed build), the key's allowlist through keyLimits, and the
// wait for a list that reflects a provider just added.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Combos come from the real database: keep it in a temp dir.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-decision-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const routed = vi.hoisted(() => ({ models: [], calls: 0, policy: null, delayMs: 0 }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async () => {
    routed.calls += 1;
    const models = routed.models;
    // Combos are listed under their names, as buildModelsList lists them.
    const { getCombos } = await import("@/lib/db/index.js");
    const combos = (await getCombos()).map((combo) => ({ id: combo.name, owned_by: "combo" }));
    if (routed.delayMs) await new Promise((resolve) => setTimeout(resolve, routed.delayMs));
    return [...combos, ...models];
  },
}));
vi.mock("@/lib/db/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getApiKeyPolicy: async (...args) => (routed.policy ? routed.policy(...args) : null),
}));

const { decideCatalogUrl } = await import("@/lib/codex/catalogUrlDecision.js");
const { resetRoutedModels, warmRoutedModels } = await import("@/lib/codex/routedModels.js");
const { bumpConnectionsVersion } = await import("@/lib/db/repos/connectionsRepo.js");
const db = await import("@/lib/db/index.js");
await (await import("@/lib/db/driver.js")).getAdapter();

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

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

describe("what the decision waits for", () => {
  it("answers codex-version without waiting for the list", async () => {
    const listIds = vi.fn(() => new Promise(() => {}));
    expect(await decideCatalogUrl({ apiKey: null, ids: ["cx/gpt-5.5"], codexVersion: [0, 165, 0], listIds }))
      .toEqual({ write: false, reason: "codex-version" });
    expect(listIds).toHaveBeenCalledTimes(1);
  });

  it("doesn't wait for a fresh list when the held one doesn't predate a write", async () => {
    const listIds = vi.fn(async () => new Set(["cx/gpt-5.5"]));
    const decision = await decideCatalogUrl({ apiKey: null, ids: ["gpt-5.5"], codexVersion: NEW, listIds, listBehind: () => false });
    expect(decision).toEqual({ write: false, reason: "not-listed" });
    // Looked at again, but not as a fresh lookup: that's the held list (at
    // once while it's under 5 minutes old, else after at most the 1s grace).
    expect(listIds.mock.calls.map((call) => Boolean(call[1]?.fresh))).toEqual([false, false]);
  });

  it("looks again after a slow version check, when a rebuild landed meanwhile", async () => {
    let rebuilt = false;
    const listIds = vi.fn(async () => new Set(rebuilt ? ["cx/gpt-5.5", "newp/model-x"] : ["cx/gpt-5.5"]));
    // `codex --version` is slow (a Windows npm shim, say); the rebuild lands
    // during it, so by the check the held list no longer predates the write.
    const codexVersion = new Promise((resolve) => setTimeout(() => { rebuilt = true; resolve(NEW); }, 50));
    const decision = await decideCatalogUrl({ apiKey: null, ids: ["newp/model-x"], codexVersion, listIds, listBehind: () => false });
    expect(decision).toEqual({ write: true, reason: "listed" });
  });

  it("lists a combo created just before Apply", async () => {
    routed.models = list("cx/gpt-5.5");
    const { getRoutedModels } = await import("@/lib/codex/routedModels.js");
    // The held list is built (without the combo) before the combo exists.
    expect((await getRoutedModels()).map((m) => m.id)).toEqual(["cx/gpt-5.5"]);
    await db.createCombo({ name: "fresh-team", models: ["cx/gpt-5.5"] });
    try {
      expect(await decideCatalogUrl({ apiKey: null, ids: ["fresh-team"], codexVersion: NEW }))
        .toEqual({ write: true, reason: "listed" });
    } finally {
      await db.deleteCombo((await db.getComboByName("fresh-team")).id);
    }
  });

  it("asks for a fresh list when the held one predates a write", async () => {
    const listIds = vi.fn(async (_key, options) => new Set(options?.fresh ? ["newp/model-x"] : []));
    const decision = await decideCatalogUrl({ apiKey: null, ids: ["newp/model-x"], codexVersion: NEW, listIds, listBehind: () => true });
    expect(decision).toEqual({ write: true, reason: "listed" });
    expect(listIds.mock.calls.map((call) => Boolean(call[1]?.fresh))).toEqual([false, true]);
  });

  it("follows a build that started before the write with one that sees it", async () => {
    const { getFreshRoutedModels } = await import("@/lib/codex/routedModels.js");
    routed.models = list("cx/gpt-5.5");
    routed.delayMs = 200;
    warmRoutedModels();
    await settle();
    // Written while that build runs: it can't include it.
    bumpConnectionsVersion();
    routed.models = list("cx/gpt-5.5", "newp/model-x");
    const models = await getFreshRoutedModels(5_000);
    expect(models.map((m) => m.id)).toEqual(["cx/gpt-5.5", "newp/model-x"]);
    expect(routed.calls).toBe(2);
  });
});

describe("combo writes", () => {
  // Auto-combo rebuilds (and holds bare-id requests) when connectionsVersion
  // moves (autoCombo.ts: attemptedVersion !== connectionsVersion()), and its
  // list doesn't change with combos. So combos keep a counter of their own.
  it("move combosVersion, not connectionsVersion", async () => {
    const { connectionsVersion, combosVersion } = db;
    const connections = connectionsVersion();
    const combos = combosVersion();
    const combo = await db.createCombo({ name: "counter-check", models: ["cx/gpt-5.5"] });
    await db.updateCombo(combo.id, { models: ["cx/gpt-5.5", "cc/claude-opus-5-5"] });
    await db.deleteCombo(combo.id);
    expect(connectionsVersion()).toBe(connections);
    expect(combosVersion()).toBe(combos + 3);
  });

  it("don't make auto-combo rebuild its list", async () => {
    const autoCombo = await import("@/sse/services/autoCombo.js");
    await autoCombo.warmAutoComboCatalog();
    // Auto-combo starts a rebuild whenever the version it last built at isn't
    // the current one (attemptedVersion !== connectionsVersion()).
    const upToDate = () => globalThis._autoComboCatalog.attemptedVersion === db.connectionsVersion();
    expect(upToDate()).toBe(true);
    await db.createCombo({ name: "auto-combo-check", models: ["cx/gpt-5.5"] });
    expect(upToDate()).toBe(true);
    await db.deleteCombo((await db.getComboByName("auto-combo-check")).id);
    expect(upToDate()).toBe(true);
    // While a connection write does trigger one.
    bumpConnectionsVersion();
    expect(upToDate()).toBe(false);
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
