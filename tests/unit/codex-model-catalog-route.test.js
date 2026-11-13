// The /backend-api/codex/models route on its own, with the routed model list
// stubbed so it can hold what the real one never does (repeated and blank
// ids) and take as long as a slow live provider catalog.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const routed = vi.hoisted(() => ({ models: [], build: null, calls: [] }));
vi.mock("@/app/api/v1/models/route.js", () => ({
  buildModelsList: async (kinds, options = {}) => {
    routed.calls.push(options);
    return routed.build ? routed.build(options) : routed.models;
  },
}));
vi.mock("@/sse/services/keyLimits.js", () => ({ filterModelsForRequest: async (_request, models) => models }));

const { GET } = await import("@/app/api/v1/codex/models/route.js");
const { resetRoutedModels } = await import("@/lib/codex/routedModels.js");

const catalog = async (query = "") => (await GET(new Request(`http://localhost/backend-api/codex/models${query}`))).json();
const ids = (body) => body.data.map((m) => m.id);

beforeEach(() => {
  resetRoutedModels();
  routed.models = [];
  routed.build = null;
  routed.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
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
    routed.models = [{ id: "acme/model-b", owned_by: "acme" }];
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = await catalog("?client_version=x1");
    for (const [i, query] of ["?client_version=x2", "?client_version=0.0.0", "", "?client_version=0.167.2"].entries()) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 10 + i)));
      expect((await catalog(query)).data[0].created, query || "(none)").toBe(first.data[0].created);
    }
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    const older = await catalog("?client_version=0.137.0");
    expect(older.data[0].created).not.toBe(first.data[0].created);
    expect(older.models.map((m) => m.slug)).not.toContain("gpt-6-astra");
  });
});

describe("the routed model list behind it", () => {
  it("is built once a minute, not per request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    routed.models = [{ id: "acme/one", owned_by: "acme" }];
    expect(ids(await catalog())).toEqual(["acme/one"]);
    routed.models = [{ id: "acme/two", owned_by: "acme" }];
    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    expect(ids(await catalog())).toEqual(["acme/one"]);
    expect(routed.calls).toHaveLength(1);

    // Stale: the old list is served while the new one is built.
    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    expect(ids(await catalog())).toEqual(["acme/one"]);
    await vi.waitFor(() => expect(routed.calls).toHaveLength(2));
    await Promise.resolve();
    expect(ids(await catalog())).toEqual(["acme/two"]);
  });

  it("doesn't make a cold start wait past a couple of seconds on a slow live catalog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let finish;
    routed.build = (options) => (options.skipLiveCatalogs
      ? [{ id: "acme/static", owned_by: "acme" }]
      : new Promise((resolve) => { finish = () => resolve([{ id: "acme/live", owned_by: "acme" }]); }));

    const pending = catalog();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ids(await pending)).toEqual(["acme/static"]);
    expect(routed.calls.map((o) => Boolean(o.skipLiveCatalogs))).toEqual([false, true]);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(await catalog())).toEqual(["acme/live"]);
  });

  it("keeps serving the last good list when a rebuild fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    routed.models = [{ id: "acme/good", owned_by: "acme" }];
    await catalog();
    routed.build = () => { throw new Error("provider down"); };
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect(ids(await catalog())).toEqual(["acme/good"]);
    await vi.waitFor(() => expect(routed.calls).toHaveLength(2));
    expect(ids(await catalog())).toEqual(["acme/good"]);
  });
});
