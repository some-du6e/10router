import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// An OpenAI-compatible node that sends claude-* models to its Anthropic /messages route.
const COMPAT_NODE = "openai-compatible-chat-test";

function claudeBody(extra = {}) {
  return {
    model: "claude-sonnet-5-5",
    max_tokens: 64000,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

function toClaude(sourceFormat, body, provider = COMPAT_NODE) {
  return translateRequest(sourceFormat, FORMATS.CLAUDE, body.model, body, true, null, provider);
}

describe("budget thinking → adaptive for models that reject budget_tokens", () => {
  it.each([
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5-5-20260901",
    "anthropic/claude-sonnet-5-5",
    "claude-haiku-5-5-20261001",
    "anthropic.claude-haiku-5-5-20261001-v1:0",
    "claude-sonnet-5-20260601",
    "claude-fable-5-20260101",
    "claude-mythos-5",
  ])("%s uses the adaptive thinking format", (model) => {
    expect(getCapabilitiesForModel(COMPAT_NODE, model).thinkingFormat).toBe("claude-adaptive");
  });

  it.each([
    ["claude-sonnet-5-5", false],
    ["claude-sonnet-5-5-20260901", false],
    ["claude-opus-5-5-20260901", false],
    ["claude-fable-5", false],
    ["claude-fable-5-20260101", false],
    ["claude-mythos-5", false],
    ["claude-haiku-5-5", true],
    ["claude-sonnet-5", true],
  ])("%s thinkingCanDisable is %s", (model, canDisable) => {
    expect(getCapabilitiesForModel(COMPAT_NODE, model).thinkingCanDisable ?? true).toBe(canDisable);
  });

  it.each(["claude-haiku-4-5", "claude-sonnet-4-5"])("%s keeps budget thinking", (model) => {
    expect(getCapabilitiesForModel(COMPAT_NODE, model).thinkingFormat).toBe("claude-budget");
  });

  it.each([
    [8192, "medium"],
    [24576, "high"],
    [512, "low"],
    [64000, "high"],
  ])("Claude client budget %i on sonnet-5-5 becomes effort %s", (budget, effort) => {
    const out = toClaude(FORMATS.CLAUDE, claudeBody({ thinking: { type: "enabled", budget_tokens: budget } }));
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toEqual({ effort });
  });

  it("keeps an effort the client already set", () => {
    const out = toClaude(FORMATS.CLAUDE, claudeBody({
      thinking: { type: "enabled", budget_tokens: 24576 },
      output_config: { effort: "low" },
    }));
    expect(out.thinking?.type).not.toBe("enabled");
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("sends adaptive (not enabled) on Haiku 5.5, which can still disable thinking", () => {
    const out = toClaude(FORMATS.CLAUDE, claudeBody({ model: "claude-haiku-5-5", thinking: { type: "enabled", budget_tokens: 8192 } }));
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("OpenAI client reasoning_effort on sonnet-5-5 becomes adaptive effort", () => {
    const out = toClaude(FORMATS.OPENAI, {
      model: "claude-sonnet-5-5",
      max_tokens: 64000,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.thinking?.type).not.toBe("enabled");
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("Responses client reasoning.effort on sonnet-5-5 becomes adaptive effort", () => {
    const out = toClaude(FORMATS.OPENAI_RESPONSES, {
      model: "claude-sonnet-5-5",
      max_output_tokens: 64000,
      reasoning: { effort: "medium" },
      input: [{ role: "user", content: "hi" }],
    });
    expect(out.thinking?.type).not.toBe("enabled");
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("native Claude passthrough rewrites enabled thinking on sonnet-5-5", () => {
    const out = normalizeClaudePassthrough(claudeBody({ thinking: { type: "enabled", budget_tokens: 24576 } }), "claude-sonnet-5-5", "claude");
    expect(out.thinking?.type).not.toBe("enabled");
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("native Claude passthrough keeps adaptive thinking on Haiku 5.5", () => {
    const out = normalizeClaudePassthrough(claudeBody({
      model: "claude-haiku-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    }), "claude-haiku-5-5", "claude");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it.each(["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4.6", "claude-sonnet-4.6"])(
    "native Claude passthrough leaves budget thinking alone on %s, which still accepts it",
    (model) => {
      const format = { type: "json_schema", schema: { type: "object" } };
      const out = normalizeClaudePassthrough(claudeBody({
        model,
        thinking: { type: "enabled", budget_tokens: 10000 },
        output_config: { format },
      }), model, "claude");
      expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
      expect(out.output_config).toEqual({ format });
    },
  );

  it("native Claude passthrough leaves an adaptive Sonnet 5.5 body untouched", () => {
    const format = { type: "json_schema", schema: { type: "object" } };
    const out = normalizeClaudePassthrough(claudeBody({
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format },
    }), "claude-sonnet-5-5", "claude");
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high", format });
  });
});
