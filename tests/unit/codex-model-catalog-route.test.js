// The /backend-api/codex/models route on its own, with the routed model list
// stubbed so it can hold what the real one never does (repeated and blank
// ids) and take as long as a slow live provider catalog.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-route-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const routed = vi.hoisted(() => ({ models: [], build: null, calls: [] }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async (kinds, options = {}) => {
    routed.calls.push(options);
    return routed.build ? routed.build(options) : routed.models;
  },
}));
vi.mock("@/sse/services/keyLimits.js", () => ({ filterModelsForRequest: async (_request, models) => models }));

const { GET } = await import("@/app/api/v1/codex/models/route.js");
const { resetRoutedModels, ROUTED_MODELS_TIMING: T } = await import("@/lib/codex/routedModels.js");
const { CATALOG_FILE } = await import("open-sse/providers/catalogOverride.js");

const catalog = async (query = "") => (await GET(new Request(`http://localhost/backend-api/codex/models${query}`))).json();
const ids = (body) => body.data.map((m) => m.id);
const list = (...names) => names.map((name) => ({ id: `acme/${name}`, owned_by: "acme" }));
const START = Date.parse("2026-01-01T00:00:00Z");
const at = (ms) => vi.setSystemTime(new Date(START + ms));
// A build the test finishes by hand: `finish(list)`.
const pendingBuild = () => {
  const handle = {};
  routed.build = (options) => (options.skipLiveCatalogs
    ? list("static")
    : new Promise((resolve) => { handle.finish = resolve; }));
  return handle;
};

beforeEach(() => {
  resetRoutedModels();
  routed.models = [];
  routed.build = null;
  routed.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Codex catalog route", () => {
  it("never repeats a slug or sends a blank one, which Codex refuses the whole list for", async () => {
    routed.models = [
      { id: "acme/model-a", owned_by: "acme" },
      { id: "acme/model-a", owned_by: "acme" },
      { id: "  ", owned_by: "acme" },
      { id: "", owned_by: "acme" },
      { id: "gpt-5.5", owned_by: "combo" },
    ];
    const body = await catalog("?client_version=0.167.2");
    const slugs = body.models.map((m) => m.slug);
    expect(slugs.filter((s) => s === "acme/model-a")).toHaveLength(1);
    expect(slugs.every((s) => s.trim() !== "")).toBe(true);
    expect(new Set(slugs).size).toBe(slugs.length);
    // The routed `gpt-5.5` wins over Codex's hidden bare one.
    expect(body.models.filter((m) => m.slug === "gpt-5.5").map((m) => m.visibility)).toEqual(["list"]);
    expect(ids(body)).toEqual(["acme/model-a", "gpt-5.5"]);
  });

  it("reuses the last body for any client_version that shapes it the same way", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    routed.models = list("model-b");
    at(0);
    const first = await catalog("?client_version=x1");
    for (const [i, query] of ["?client_version=x2", "?client_version=0.0.0", "", "?client_version=0.167.2"].entries()) {
      at(10_000 + i * 1_000);
      expect((await catalog(query)).data[0].created, query || "(none)").toBe(first.data[0].created);
    }
    at(30_000);
    const older = await catalog("?client_version=0.137.0");
    expect(older.data[0].created).not.toBe(first.data[0].created);
    expect(older.models.map((m) => m.slug)).not.toContain("gpt-6-astra");
  });

  it("rebuilds the body when the synced models.dev catalog changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    routed.models = list("model-c");
    fs.writeFileSync(CATALOG_FILE, JSON.stringify({ v: 1, models: {}, providers: {} }));
    fs.utimesSync(CATALOG_FILE, new Date(START - 60_000), new Date(START - 60_000));
    at(0);
    const first = await catalog();
    at(10_000);
    expect((await catalog()).data[0].created).toBe(first.data[0].created);
    fs.utimesSync(CATALOG_FILE, new Date(START + 5_000), new Date(START + 5_000));
    at(20_000);
    expect((await catalog()).data[0].created).not.toBe(first.data[0].created);
    fs.rmSync(CATALOG_FILE, { force: true });
  });
});

describe("the routed model list behind it", () => {
  it("is built once a minute, not per request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    routed.models = list("one");
    expect(ids(await catalog())).toEqual(["acme/one"]);
    routed.models = list("two");
    at(T.FRESH_MS - 1_000);
    expect(ids(await catalog())).toEqual(["acme/one"]);
    expect(routed.calls).toHaveLength(1);
  });

  it("serves a list up to five minutes old at once, while rebuilding it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    routed.models = list("one");
    await catalog();
    const build = pendingBuild();
    at(T.SERVE_STALE_MS - 1_000);
    expect(ids(await catalog())).toEqual(["acme/one"]);
    build.finish(list("two"));
    await vi.waitFor(async () => expect(ids(await catalog())).toEqual(["acme/two"]));
  });

  it("waits for the rebuild of a list older than five minutes, so a new model isn't missed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    at(0);
    routed.models = list("one");
    await catalog();
    const build = pendingBuild();
    at(T.SERVE_STALE_MS + 60_000);
    const pending = catalog();
    await vi.advanceTimersByTimeAsync(500);
    build.finish(list("one", "added"));
    expect(ids(await pending)).toEqual(["acme/one", "acme/added"]);
  });

  it("serves the old list, not the static one, when that rebuild takes too long", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    at(0);
    routed.models = list("one");
    await catalog();
    pendingBuild();
    at(T.SERVE_STALE_MS + 60_000);
    const pending = catalog();
    await vi.advanceTimersByTimeAsync(T.WAIT_MS);
    expect(ids(await pending)).toEqual(["acme/one"]);
  });

  it("answers a cold start from the static lists within the wait, and the live list after", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expect(T.WAIT_MS).toBeLessThanOrEqual(4_000);
    const build = pendingBuild();
    const pending = catalog();
    await vi.advanceTimersByTimeAsync(T.WAIT_MS);
    expect(ids(await pending)).toEqual(["acme/static"]);
    expect(routed.calls.map((o) => Boolean(o.skipLiveCatalogs))).toEqual([false, true]);
    build.finish(list("live"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(await catalog())).toEqual(["acme/live"]);
  });

  it("gives up on a rebuild that hangs, so the next one can start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    pendingBuild();
    const pending = catalog();
    await vi.advanceTimersByTimeAsync(T.WAIT_MS);
    await pending;
    expect(routed.calls.filter((o) => !o.skipLiveCatalogs)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(T.BUILD_DEADLINE_MS);
    expect(log.mock.calls.flat().join(" ")).toContain(`no list after ${T.BUILD_DEADLINE_MS}ms`);

    routed.build = null;
    routed.models = list("recovered");
    expect(ids(await catalog())).toEqual(["acme/recovered"]);
    log.mockRestore();
  });

  it("keeps serving the last good list when a rebuild fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    routed.models = list("good");
    await catalog();
    routed.build = () => { throw new Error("provider down"); };
    at(T.FRESH_MS + 1_000);
    expect(ids(await catalog())).toEqual(["acme/good"]);
    await vi.waitFor(() => expect(routed.calls).toHaveLength(2));
    expect(ids(await catalog())).toEqual(["acme/good"]);
  });
});
