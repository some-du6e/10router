import { describe, it, expect } from "vitest";
import REGISTRY from "open-sse/providers/registry/index.js";
import {
  VENDORS,
  VENDOR_BY_ROUTE,
  RANK_SCORES,
  AAII_SCORES,
  rankScore,
  vendorRankScore,
  DEFAULT_SCORE,
} from "@/shared/constants/providerVendors.js";

const REGISTRY_IDS = new Set(REGISTRY.map((r) => r.id));

// VENDORS and RANK_SCORES are hand-maintained tables keyed by registry id.
// These tests catch the silent failure mode: an id is renamed or removed
// upstream and the vendor card quietly loses an endpoint.
describe("provider vendor grouping", () => {
  it("every vendor route points at a real registry entry", () => {
    const missing = VENDORS.flatMap((v) =>
      v.routes.filter(([id]) => !REGISTRY_IDS.has(id)).map(([id]) => `${v.id} -> ${id}`),
    );
    expect(missing).toEqual([]);
  });

  it("every ranked id is a real registry entry", () => {
    const missing = Object.keys(RANK_SCORES).filter((id) => !REGISTRY_IDS.has(id));
    expect(missing).toEqual([]);
  });

  it("no endpoint is claimed by two vendors", () => {
    const seen = new Set();
    const dupes = [];
    for (const v of VENDORS) {
      for (const [id] of v.routes) {
        if (seen.has(id)) dupes.push(id);
        seen.add(id);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("vendor ids and names are unique", () => {
    expect(new Set(VENDORS.map((v) => v.id)).size).toBe(VENDORS.length);
    expect(new Set(VENDORS.map((v) => v.name)).size).toBe(VENDORS.length);
  });

  it("a vendor card needs at least two endpoints to be worth grouping", () => {
    const thin = VENDORS.filter((v) => v.routes.length < 2).map((v) => v.id);
    expect(thin).toEqual([]);
  });

  it("VENDOR_BY_ROUTE maps each route back to its vendor", () => {
    for (const v of VENDORS) {
      for (const [id] of v.routes) expect(VENDOR_BY_ROUTE[id].id).toBe(v.id);
    }
  });

  it("every AAII-scored lab is an actual vendor", () => {
    const ids = new Set(VENDORS.map((v) => v.id));
    expect(Object.keys(AAII_SCORES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("a vendor ranks by its strongest endpoint", () => {
    const openai = VENDORS.find((v) => v.id === "openai");
    expect(vendorRankScore(openai)).toBe(rankScore("codex"));
  });

  it("unknown ids fall back to the default score", () => {
    expect(rankScore("definitely-not-a-provider")).toBe(DEFAULT_SCORE);
  });

  it("frontier labs outrank aggregators and resellers", () => {
    expect(rankScore("claude")).toBeGreaterThan(rankScore("openrouter"));
    expect(rankScore("openrouter")).toBeGreaterThan(rankScore("groq"));
    // Cursor fronts Claude/GPT, so it beats an open-weights-only host.
    expect(rankScore("cursor")).toBeGreaterThan(rankScore("chutes"));
  });
});
