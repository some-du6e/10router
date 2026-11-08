// What the dashboard's key limits dialog saves. The expiry field holds
// minutes, so resending an unchanged expiry would change its instant (drop the
// seconds) and make the dashboard the owner of an expiry a management key set.
import { describe, it, expect } from "vitest";
import { buildKeyLimitsPayload, isoToLocalInput } from "@/app/(dashboard)/dashboard/endpoint/components/keyFormat.js";

describe("buildKeyLimitsPayload", () => {
  const saved = "2027-06-01T10:20:30.000Z"; // has seconds

  it("leaves out an expiry the user didn't touch, even one with seconds", () => {
    const payload = buildKeyLimitsPayload({ budget: "5", models: ["openai/gpt-5"], expiry: isoToLocalInput(saved), savedExpiresAt: saved });
    expect(payload).toEqual({ budgetUsd: 5, allowedModels: ["openai/gpt-5"] });
    expect(payload).not.toHaveProperty("expiresAt");
  });

  it("sends a changed or cleared expiry", () => {
    expect(buildKeyLimitsPayload({ budget: "", models: [], expiry: "2027-07-01T09:00", savedExpiresAt: saved }).expiresAt)
      .toBe(new Date("2027-07-01T09:00").toISOString());
    expect(buildKeyLimitsPayload({ budget: "", models: [], expiry: "", savedExpiresAt: saved })).toEqual({ budgetUsd: null, allowedModels: null, expiresAt: null });
    expect(buildKeyLimitsPayload({ budget: "1", models: [], expiry: "", savedExpiresAt: null })).toEqual({ budgetUsd: 1, allowedModels: null });
  });
});
