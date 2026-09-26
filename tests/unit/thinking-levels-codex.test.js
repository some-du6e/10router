import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("Codex thinking levels", () => {
  it.each([
    ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-sol", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna", ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-sol-review", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra-review", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna-review", ["none", "minimal", "low", "medium", "high", "xhigh", "max"]],
  ])("returns Codex levels for %s", (model, expected) => {
    expect(getThinkingLevels("codex", model)).toEqual(expected);
  });

  it("keeps GPT-5.3 Codex's existing effort levels", () => {
    const levels = getThinkingLevels("codex", "gpt-5.3-codex");
    expect(levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("does not add max for GPT-5.5 on Codex", () => {
    const levels = getThinkingLevels("codex", "gpt-5.5");
    expect(levels || []).not.toContain("max");
  });
});
