import { describe, it, expect } from "vitest";
import { resolveConnectionPlan, planCanServeModel } from "@/shared/utils/planCapability.js";

describe("resolveConnectionPlan", () => {
  it("prefers an explicit plan over the OAuth-captured one", () => {
    expect(resolveConnectionPlan({
      plan: "Plus",
      providerSpecificData: { chatgptPlanType: "free" },
    })).toBe("plus");
  });

  it("falls back to the OAuth-captured plan", () => {
    expect(resolveConnectionPlan({ providerSpecificData: { chatgptPlanType: "FREE" } })).toBe("free");
  });

  it("returns null when nothing is recorded", () => {
    expect(resolveConnectionPlan({ providerSpecificData: {} })).toBeNull();
    expect(resolveConnectionPlan({ plan: "   " })).toBeNull();
    expect(resolveConnectionPlan(null)).toBeNull();
  });
});

describe("planCanServeModel", () => {
  const free = { providerSpecificData: { chatgptPlanType: "free" } };
  const plus = { providerSpecificData: { chatgptPlanType: "plus" } };

  it("keeps a free account off the models it cannot run", () => {
    expect(planCanServeModel("codex", free, "gpt-5.6-sol")).toBe(false);
    expect(planCanServeModel("codex", free, "gpt-5.6-sol-review")).toBe(false);
  });

  it("still serves the free-tier models from a free account", () => {
    expect(planCanServeModel("codex", free, "gpt-5.6-luna")).toBe(true);
    expect(planCanServeModel("codex", free, "gpt-5.6-terra")).toBe(true);
    expect(planCanServeModel("codex", free, "gpt-5.6-terra-review")).toBe(true);
  });

  it("leaves paid plans alone", () => {
    expect(planCanServeModel("codex", plus, "gpt-5.6-sol")).toBe(true);
  });

  it("fails open on an unknown plan, provider, or model", () => {
    expect(planCanServeModel("codex", { providerSpecificData: {} }, "gpt-5.6-sol")).toBe(true);
    expect(planCanServeModel("codex", { plan: "enterprise" }, "gpt-5.6-sol")).toBe(true);
    expect(planCanServeModel("openai", free, "gpt-5.6-sol")).toBe(true);
    expect(planCanServeModel("codex", free, null)).toBe(true);
  });
});
