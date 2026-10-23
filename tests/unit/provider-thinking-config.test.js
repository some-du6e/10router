import { describe, it, expect } from "vitest";
import { normalizeThinkingConfig } from "../../open-sse/services/provider.js";

describe("normalizeThinkingConfig", () => {
  it("keeps openai reasoning_effort on non-user turns", () => {
    const body = {
      messages: [{ role: "assistant", content: "ok" }],
      reasoning_effort: "xhigh",
      thinking: { type: "enabled" },
    };

    normalizeThinkingConfig(body);

    expect(body.reasoning_effort).toBe("xhigh");
    expect(body.thinking).toBeUndefined();
  });

  it("keeps thinking when only system turns follow the user turn", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "<system-reminder>x</system-reminder>" },
      ],
      thinking: { type: "adaptive", display: "summarized" },
    };

    normalizeThinkingConfig(body);

    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("still drops thinking when an assistant turn comes before the trailing system turn", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "system", content: "x" },
      ],
      thinking: { type: "enabled" },
    };

    normalizeThinkingConfig(body);

    expect(body.thinking).toBeUndefined();
  });
});

