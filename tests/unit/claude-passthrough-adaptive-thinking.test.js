// Older Claude Code builds send thinking.type "enabled" + budget_tokens for every
// model. The 5.5 models 400 with "thinking.type.enabled is not supported" (checked
// against Snowflake Cortex), so the passthrough must turn the budget into an effort.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const enabled = (budget_tokens, extra = {}) => ({ messages: [], thinking: { type: "enabled", budget_tokens, ...extra } });

describe("capabilities — 5.5 models", () => {
  it.each([
    "claude-sonnet-5-5",
    "anthropic/claude-sonnet-5-5",
    "claude-sonnet-5-5-20261001",
    "anthropic.claude-sonnet-5-5-v1:0",
    "claude-sonnet-5.5",
  ])("treats %s as adaptive that cannot disable thinking", (model) => {
    expect(getCapabilitiesForModel(null, model)).toMatchObject({
      thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false,
    });
  });

  it.each(["claude-haiku-5-5", "claude-haiku-5-5-20261001", "claude-haiku-5.5"])(
    "treats %s as adaptive that can disable thinking",
    (model) => {
      expect(getCapabilitiesForModel(null, model)).toMatchObject({
        thinkingFormat: "claude-adaptive",
        thinkingCanDisable: true,
      });
    },
  );

  it("keeps Sonnet 5 adaptive and older Haiku on budget thinking", () => {
    expect(getCapabilitiesForModel(null, "claude-sonnet-5-20260601")).toMatchObject({ thinkingFormat: "claude-adaptive", thinkingCanDisable: true });
    expect(getCapabilitiesForModel(null, "claude-haiku-4-5")).toMatchObject({ thinkingFormat: "claude-budget" });
  });
});

describe("normalizeClaudePassthrough — budget thinking on adaptive models", () => {
  it("rewrites Sonnet 5.5 budget thinking to adaptive + effort", () => {
    const out = normalizeClaudePassthrough(enabled(8192), "claude-sonnet-5-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("keeps display on models that cannot disable thinking", () => {
    const out = normalizeClaudePassthrough(enabled(24576, { display: "summarized" }), "claude-sonnet-5-5");
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("rewrites Haiku 5.5 and does not downgrade it back to budget thinking", () => {
    const out = normalizeClaudePassthrough(enabled(8192), "claude-haiku-5-5");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "medium" });

    const adaptive = normalizeClaudePassthrough(
      { messages: [], thinking: { type: "adaptive" }, output_config: { effort: "low" } },
      "claude-haiku-5-5",
    );
    expect(adaptive.thinking).toEqual({ type: "adaptive" });
    expect(adaptive.output_config).toEqual({ effort: "low" });
  });

  it.each([
    [512, "low"],      // budgetToLevel → minimal, which the effort enum rejects
    [31999, "high"],   // ultrathink → xhigh, clamped like applyThinking
    [undefined, "high"],
  ])("maps budget %s to effort %s", (budget, effort) => {
    const out = normalizeClaudePassthrough(enabled(budget), "claude-sonnet-5-5");
    expect(out.output_config).toEqual({ effort });
  });

  it("keeps an explicit effort and other output_config fields", () => {
    const body = { ...enabled(1024), output_config: { effort: "max", format: { type: "json_schema" } } };
    const out = normalizeClaudePassthrough(body, "claude-sonnet-5-5");
    expect(out.output_config).toEqual({ effort: "max", format: { type: "json_schema" } });
  });

  it("does not mutate the caller's output_config", () => {
    const output_config = { format: { type: "json_schema" } };
    normalizeClaudePassthrough({ ...enabled(8192), output_config }, "claude-sonnet-5-5");
    expect(output_config).toEqual({ format: { type: "json_schema" } });
  });

  it("leaves budget thinking alone on budget models, and still downgrades old Haiku", () => {
    const out = normalizeClaudePassthrough(enabled(8192), "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(out.output_config).toBeUndefined();

    const old = normalizeClaudePassthrough(
      { messages: [], thinking: { type: "adaptive" }, output_config: { effort: "low" } },
      "claude-haiku-4-5",
    );
    expect(old.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(old.output_config).toBeUndefined();
  });
});
