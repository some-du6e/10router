import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

describe("Thinking-level provider isolation", () => {
  it("does not expose Codex-only GPT-5.6 overrides on Kiro", () => {
    expect(getThinkingLevels("kiro", "gpt-5.6-sol")).toEqual([
      "none", "minimal", "low", "medium", "high", "xhigh",
    ]);
  });
});
