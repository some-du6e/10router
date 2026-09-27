import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Claude adaptive thinking", () => {
  it.each(["claude-opus-5-5", "claude-fable-5-1"])("uses low effort when disabling always-on thinking for %s", (model) => {
    const body = applyThinking(FORMATS.CLAUDE, model, { thinking: { type: "disabled" } }, "anthropic");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("thinking");
  });

  it("preserves disabling thinking for Sonnet 5", () => {
    const body = applyThinking(FORMATS.CLAUDE, "claude-sonnet-5", { thinking: { type: "disabled" } }, "anthropic");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("output_config");
  });

  it("preserves explicit effort for Opus 5.5", () => {
    const body = applyThinking(FORMATS.CLAUDE, "claude-opus-5-5", { output_config: { effort: "max" } }, "anthropic");
    expect(body.output_config).toEqual({ effort: "max" });
  });
});
