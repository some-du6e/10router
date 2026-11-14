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
  const CLOCK = ["setTimeout", "clearTimeout", "Date", "performance"];
  const advance = (ms) => vi.advanceTimersByTimeAsync(ms);
  // Builds the test finishes by hand, in the order they start: builds[i].finish(list).
  const pendingBuilds = () => {
    const builds = [];
    routed.build = (options) => {
      if (options.skipLiveCatalogs) return list("static");
      return new Promise((resolve) => { builds.push({ finish: resolve }); });
    };
    return builds;
  };

  it("keeps its timings inside Codex's 5 seconds and 5-minute refresh", () => {
    expect(T.SERVE_STALE_MS).toBeLessThanOrEqual(300_000);
    expect(T.STALE_GRACE_MS).toBeLessThanOrEqual(1_500);
    expect(T.WAIT_MS).toBeLessThanOrEqual(4_000);
  });

  it("is built once a minute, not per request", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    routed.models = list("one");
    expect(ids(await catalog())).toEqual(["acme/one"]);
    routed.models = list("two");
    await advance(T.FRESH_MS - 1_000);
    expect(ids(await catalog())).toEqual(["acme/one"]);
    expect(routed.calls).toHaveLength(1);
  });

  it("serves a list up to five minutes old at once, while rebuilding it", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    routed.models = list("one");
    await catalog();
    const builds = pendingBuilds();
    await advance(T.SERVE_STALE_MS - 1_000);
    expect(ids(await catalog())).toEqual(["acme/one"]);
    builds[0].finish(list("two"));
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/two"]);
  });

  it("gives an older list's rebuild a short grace, so a quick one isn't missed", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    routed.models = list("one");
    await catalog();
    const builds = pendingBuilds();
    await advance(T.SERVE_STALE_MS + 60_000);
    const pending = catalog();
    await advance(T.STALE_GRACE_MS / 2);
    builds[0].finish(list("one", "added"));
    expect(ids(await pending)).toEqual(["acme/one", "acme/added"]);
  });

  it("serves the old list after the grace, not the static one, and keeps rebuilding", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    routed.models = list("one");
    await catalog();
    const builds = pendingBuilds();
    await advance(T.SERVE_STALE_MS + 60_000);
    let answered = false;
    const pending = catalog().then((body) => { answered = true; return body; });
    await advance(T.STALE_GRACE_MS);
    expect(answered).toBe(true);
    expect(ids(await pending)).toEqual(["acme/one"]);
    builds[0].finish(list("one", "added"));
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/one", "acme/added"]);
  });

  it("answers a cold start from the static lists within the longer wait, and the live list after", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const builds = pendingBuilds();
    const pending = catalog();
    await advance(T.WAIT_MS);
    expect(ids(await pending)).toEqual(["acme/static"]);
    expect(routed.calls.map((o) => Boolean(o.skipLiveCatalogs))).toEqual([false, true]);
    builds[0].finish(list("live"));
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/live"]);
  });

  it("gives a cold-start build that takes longer than the grace the live list", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    expect(T.WAIT_MS).toBeGreaterThan(T.STALE_GRACE_MS + 1_000);
    const builds = pendingBuilds();
    const pending = catalog();
    await advance(T.STALE_GRACE_MS + 1_000);
    builds[0].finish(list("live"));
    expect(ids(await pending)).toEqual(["acme/live"]);
    expect(routed.calls.filter((o) => o.skipLiveCatalogs)).toHaveLength(0);
  });

  it("holds the static fallback, so the next request waits only the grace while the build hangs", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const builds = pendingBuilds();
    const first = catalog();
    await advance(T.WAIT_MS);
    expect(ids(await first)).toEqual(["acme/static"]);

    let answered = false;
    const second = catalog().then((body) => { answered = true; return body; });
    await advance(T.STALE_GRACE_MS);
    expect(answered).toBe(true);
    expect(ids(await second)).toEqual(["acme/static"]);
    // One live build so far (still running), and one static fallback.
    expect(routed.calls.map((o) => Boolean(o.skipLiveCatalogs))).toEqual([false, true]);

    builds[0].finish(list("live"));
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/live"]);
  });

  it("gives up on a rebuild that hangs, so the next one can start", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    pendingBuilds();
    const pending = catalog();
    await advance(T.WAIT_MS);
    await pending;
    await advance(T.BUILD_DEADLINE_MS);
    expect(log.mock.calls.flat().join(" ")).toContain(`no list after ${T.BUILD_DEADLINE_MS}ms`);
    routed.build = null;
    routed.models = list("recovered");
    expect(ids(await catalog())).toEqual(["acme/recovered"]);
    log.mockRestore();
  });

  it("lets an abandoned build that lands while a newer one still runs fill the list", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const builds = pendingBuilds();
    const first = catalog();
    await advance(T.WAIT_MS);
    await first;
    await advance(T.BUILD_DEADLINE_MS);
    const second = catalog();
    await advance(T.STALE_GRACE_MS);
    await second;
    expect(builds).toHaveLength(2);
    builds[0].finish(list("first"));
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/first"]);
    builds[1].finish(list("second"));
    await advance(0);
    await advance(T.FRESH_MS);
    // The newer build replaced it when it landed.
    routed.build = () => new Promise(() => {});
    expect(ids(await catalog())).toEqual(["acme/second"]);
    log.mockRestore();
  });

  it("doesn't let an abandoned build that lands late replace a newer list", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const builds = pendingBuilds();
    const first = catalog();
    await advance(T.WAIT_MS);
    expect(ids(await first)).toEqual(["acme/static"]);
    await advance(T.BUILD_DEADLINE_MS);
    const second = catalog();
    await advance(0);
    builds[1].finish(list("newer"));
    expect(ids(await second)).toEqual(["acme/newer"]);
    builds[0].finish(list("older"));
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/newer"]);
    log.mockRestore();
  });

  it("still fills a cold cache with a build that lands after its deadline", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const builds = pendingBuilds();
    const first = catalog();
    await advance(T.WAIT_MS);
    await first;
    await advance(T.BUILD_DEADLINE_MS + 5_000);
    builds[0].finish(list("late"));
    await advance(0);
    routed.build = () => { throw new Error("should not rebuild a fresh list"); };
    expect(ids(await catalog())).toEqual(["acme/late"]);
    log.mockRestore();
  });

  it("keeps serving the last good list when a rebuild fails", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    routed.models = list("good");
    await catalog();
    routed.build = () => { throw new Error("provider down"); };
    await advance(T.FRESH_MS + 1_000);
    expect(ids(await catalog())).toEqual(["acme/good"]);
    await advance(0);
    expect(routed.calls).toHaveLength(2);
    expect(ids(await catalog())).toEqual(["acme/good"]);
    log.mockRestore();
  });

  it("is built at server boot, so the first request doesn't wait for it", async () => {
    const { warmRoutedModels } = await import("@/lib/codex/routedModels.js");
    routed.models = list("warm");
    warmRoutedModels();
    expect(routed.calls).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(ids(await catalog())).toEqual(["acme/warm"]);
    expect(routed.calls).toHaveLength(1);
  });

  it("rebuilds on the next request after a connection changes, with the short grace", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    const { bumpConnectionsVersion } = await import("@/lib/db/repos/connectionsRepo.js");
    routed.models = list("one");
    await catalog();
    await advance(1_000);
    // Fresh, so no rebuild yet.
    routed.models = list("one", "added");
    expect(ids(await catalog())).toEqual(["acme/one"]);
    bumpConnectionsVersion();
    expect(ids(await catalog())).toEqual(["acme/one", "acme/added"]);
    expect(routed.calls).toHaveLength(2);

    // A slow rebuild: the held list after the grace.
    const builds = pendingBuilds();
    bumpConnectionsVersion();
    let answered = false;
    const pending = catalog().then((body) => { answered = true; return body; });
    await advance(T.STALE_GRACE_MS);
    expect(answered).toBe(true);
    expect(ids(await pending)).toEqual(["acme/one", "acme/added"]);
    builds[0].finish(list("two"));
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/two"]);
  });

  it("measures age on a monotonic clock, so moving the wall clock back doesn't freeze the list", async () => {
    vi.useFakeTimers({ toFake: CLOCK });
    routed.models = list("one");
    await catalog();
    routed.models = list("two");
    await advance(T.FRESH_MS + 1_000);
    vi.setSystemTime(new Date(Date.now() - 3_600_000));
    await catalog();
    await advance(0);
    expect(ids(await catalog())).toEqual(["acme/two"]);
  });
});
