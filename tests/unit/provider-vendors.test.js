import { describe, it, expect } from "vitest";
import REGISTRY from "open-sse/providers/registry/index.js";
import {
  VENDORS,
  VENDOR_BY_ROUTE,
  RANK_ORDER,
  UNRANKED,
  CUSTOM_ENDPOINT_RANK,
  rankOf,
} from "@/shared/constants/providerVendors.js";

const REGISTRY_IDS = new Set(REGISTRY.map((r) => r.id));

// VENDORS and RANK_ORDER are hand-maintained tables keyed by registry or vendor id.
// These tests catch the silent failure mode: an id is renamed or removed
// upstream and the vendor card quietly loses an endpoint.
describe("provider vendor grouping", () => {
  it("every vendor route points at a real registry entry", () => {
    const missing = VENDORS.flatMap((v) =>
      v.routes.filter(([id]) => !REGISTRY_IDS.has(id)).map(([id]) => `${v.id} -> ${id}`),
    );
    expect(missing).toEqual([]);
  });

  it("every ranked id is a vendor card or a stand-alone registry entry", () => {
    const vendorIds = new Set(VENDORS.map((v) => v.id));
    const bad = RANK_ORDER.filter((id) => !vendorIds.has(id) && (!REGISTRY_IDS.has(id) || VENDOR_BY_ROUTE[id]));
    expect(bad).toEqual([]);
  });

  it("ranks each card once", () => {
    expect(new Set(RANK_ORDER).size).toBe(RANK_ORDER.length);
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

  it("follows the user's ranking: labs, then gateways", () => {
    expect(RANK_ORDER.slice(0, 4)).toEqual(["anthropic", "openai", "openrouter", "xai"]);
    expect(rankOf("anthropic")).toBeLessThan(rankOf("google"));
  });

  it("unranked ids sort after every ranked one", () => {
    expect(rankOf("definitely-not-a-provider")).toBe(UNRANKED);
  });

  it("custom endpoints land right after OpenRouter", () => {
    expect(CUSTOM_ENDPOINT_RANK).toBeGreaterThan(rankOf("openrouter"));
    expect(CUSTOM_ENDPOINT_RANK).toBeLessThan(rankOf("xai"));
  });
});
