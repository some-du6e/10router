import { describe, it, expect } from "vitest";
import { ANTIGRAVITY_PROMPT_REWRITES } from "../../open-sse/config/appConstants.js";

const rewrite = (text) => ANTIGRAVITY_PROMPT_REWRITES.reduce((t, { from, to }) => t.replaceAll(from, to), text);

describe("Antigravity system prompt rewrites", () => {
  // Antigravity answers 429 to system prompts carrying another client's branding.
  it("strips the Claude Code identity line and keeps the rest of the prompt", () => {
    expect(rewrite("You are Claude Code, Anthropic's official CLI for Claude.\nBe careful.")).toBe("\nBe careful.");
  });
});
