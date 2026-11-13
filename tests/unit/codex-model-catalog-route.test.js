// The /backend-api/codex/models route on its own, with the routed model list
// stubbed so it can hold what the real one never does (repeated and blank ids).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const routed = vi.hoisted(() => ({ models: [] }));
vi.mock("@/app/api/v1/models/route.js", () => ({ buildModelsList: async () => routed.models }));
vi.mock("@/sse/services/keyLimits.js", () => ({ filterModelsForRequest: async (_request, models) => models }));

const { GET } = await import("@/app/api/v1/codex/models/route.js");

const catalog = async (query = "") => (await GET(new Request(`http://localhost/backend-api/codex/models${query}`))).json();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
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
    expect(body.data.map((m) => m.id)).toEqual(["acme/model-a", "gpt-5.5"]);
  });

  it("reuses the last body for any client_version that shapes it the same way", async () => {
    routed.models = [{ id: "acme/model-b", owned_by: "acme" }];
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const first = await catalog("?client_version=x1");
    for (const [i, query] of ["?client_version=x2", "?client_version=0.0.0", "", "?client_version=0.167.2"].entries()) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 1 + i)));
      expect((await catalog(query)).data[0].created, query || "(none)").toBe(first.data[0].created);
    }
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const older = await catalog("?client_version=0.137.0");
    expect(older.data[0].created).not.toBe(first.data[0].created);
    expect(older.models.map((m) => m.slug)).not.toContain("gpt-6-astra");
  });
});
