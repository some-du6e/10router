import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-model-cache-"));
process.env.DATA_DIR = dataDir;
vi.resetModules();

const db = await import("../../src/lib/db/index.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { invalidateModelAliasCache } = await import("../../src/lib/db/repos/aliasRepo.js");
const { invalidateProviderNodesCache } = await import("../../src/lib/db/repos/nodesRepo.js");
const { getModelInfo } = await import("../../src/sse/services/model.js");
const adapter = await getAdapter();

afterEach(() => vi.restoreAllMocks());

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function countReads(table) {
  const spy = vi.spyOn(adapter, "all");
  return () => spy.mock.calls.filter(([sql, params]) => sql.includes(table) || params?.includes?.(table)).length;
}

describe("model alias cache", () => {
  it("serves repeat reads within the TTL from memory", async () => {
    await db.setModelAlias("fast", "openai/gpt-4o");
    await db.getModelAliases();
    const reads = countReads("modelAliases");
    for (let i = 0; i < 5; i++) await getModelInfo("fast");
    expect(reads()).toBe(0);
  });

  it("sees alias writes and deletes immediately", async () => {
    await db.setModelAlias("mine", "openai/gpt-4o");
    expect(await getModelInfo("mine")).toMatchObject({ provider: "openai", model: "gpt-4o" });
    await db.setModelAlias("mine", "anthropic/claude-sonnet-5");
    expect(await getModelInfo("mine")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
    await db.deleteModelAlias("mine");
    expect((await db.getModelAliases()).mine).toBeUndefined();
  });

  it("does not cache rows read before a concurrent write", async () => {
    await db.setModelAlias("race", "openai/old");
    invalidateModelAliasCache();
    const original = adapter.all;
    vi.spyOn(adapter, "all").mockImplementationOnce(function (...args) {
      const rows = original.apply(this, args);
      // A write lands after this read fetched its rows but before it publishes.
      adapter.run(`UPDATE kv SET value = ? WHERE scope = 'modelAliases' AND key = 'race'`, [JSON.stringify("openai/new")]);
      invalidateModelAliasCache();
      return rows;
    });
    expect((await db.getModelAliases()).race).toBe("openai/old");
    expect((await db.getModelAliases()).race).toBe("openai/new");
  });

  it("returns a map callers cannot edit", async () => {
    await db.setModelAlias("frozen", "openai/gpt-4o");
    const aliases = await db.getModelAliases();
    expect(() => { aliases.frozen = "x"; }).toThrow();
  });

  it("drops cached aliases and nodes when a backup is restored", async () => {
    await db.setModelAlias("before", "openai/gpt-4o");
    await db.getModelAliases();
    await db.getProviderNodes();
    await db.importDb({
      modelAliases: { after: "openai/gpt-4o" },
      providerNodes: [{ id: "restored", type: "openai-compatible", name: "r", prefix: "rst" }],
    });
    expect(Object.keys(await db.getModelAliases())).toEqual(["after"]);
    expect((await db.getProviderNodes()).map((n) => n.id)).toEqual(["restored"]);
  });
});

describe("provider node cache", () => {
  it("serves repeat reads within the TTL from memory", async () => {
    await db.createProviderNode({ type: "openai-compatible", name: "n", prefix: "hit", baseUrl: "http://x" });
    await db.getProviderNodes();
    const reads = countReads("providerNodes");
    for (let i = 0; i < 5; i++) expect(await getModelInfo("hit/m")).toMatchObject({ model: "m" });
    expect(reads()).toBe(0);
  });

  it("sees node creates, updates and deletes immediately", async () => {
    const node = await db.createProviderNode({ type: "openai-compatible", name: "n", prefix: "newnode", baseUrl: "http://x" });
    expect(await getModelInfo("newnode/m")).toEqual({ provider: node.id, model: "m" });

    await db.updateProviderNode(node.id, { prefix: "renamed" });
    expect(await getModelInfo("renamed/m")).toEqual({ provider: node.id, model: "m" });
    expect((await getModelInfo("newnode/m")).provider).not.toBe(node.id);

    await db.deleteProviderNode(node.id);
    expect((await getModelInfo("renamed/m")).provider).not.toBe(node.id);
  });

  it("filters by type and hands out copies", async () => {
    await db.createProviderNode({ type: "anthropic-compatible", name: "a", prefix: "anth", baseUrl: "http://x" });
    const [anth] = await db.getProviderNodes({ type: "anthropic-compatible" });
    expect(anth.prefix).toBe("anth");
    expect((await db.getProviderNodes({ type: "openai-compatible" })).some((n) => n.prefix === "anth")).toBe(false);
    anth.prefix = "edited";
    expect((await db.getProviderNodes({ type: "anthropic-compatible" }))[0].prefix).toBe("anth");
  });

  it("does not cache rows read before a concurrent write", async () => {
    const node = await db.createProviderNode({ type: "openai-compatible", name: "n", prefix: "raceold", baseUrl: "http://x" });
    invalidateProviderNodesCache();
    const original = adapter.all;
    vi.spyOn(adapter, "all").mockImplementationOnce(function (...args) {
      const rows = original.apply(this, args);
      adapter.run(`UPDATE providerNodes SET data = ? WHERE id = ?`, [JSON.stringify({ prefix: "racenew", baseUrl: "http://x" }), node.id]);
      invalidateProviderNodesCache();
      return rows;
    });
    await db.getProviderNodes();
    expect((await db.getProviderNodes()).find((n) => n.id === node.id).prefix).toBe("racenew");
  });
});
