// Older Claude Code builds send thinking.type "enabled" + budget_tokens for every
// model. Adaptive-only models (Sonnet 5.5) 400 with "thinking.type.enabled is not
// supported", so the passthrough must translate the budget into an effort.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

const enabled = (budget_tokens) => ({ messages: [], thinking: { type: "enabled", budget_tokens } });

describe("normalizeClaudePassthrough — budget thinking on adaptive models", () => {
  it("treats claude-sonnet-5-5 as always-on adaptive", () => {
    expect(getCapabilitiesForModel("openai-compatible-chat-x", "claude-sonnet-5-5")).toMatchObject({
      thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false,
    });
  });

  it("drops enabled thinking for Sonnet 5.5 and keeps the budget as an effort", () => {
    const out = normalizeClaudePassthrough(enabled(8192), "claude-sonnet-5-5");
    expect(out.thinking).toBeUndefined();
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("switches models that can disable thinking to adaptive, keeping display", () => {
    const out = normalizeClaudePassthrough(
      { messages: [], thinking: { type: "enabled", budget_tokens: 24576, display: "summarized" } },
      "claude-sonnet-4-6",
    );
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("keeps an explicit effort and other output_config fields", () => {
    const body = { ...enabled(1024), output_config: { effort: "max", format: { type: "json_schema" } } };
    const out = normalizeClaudePassthrough(body, "claude-sonnet-5-5");
    expect(out.output_config).toEqual({ effort: "max", format: { type: "json_schema" } });
  });

  it("leaves budget thinking alone on budget models", () => {
    const out = normalizeClaudePassthrough(enabled(8192), "claude-haiku-4-5");
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(out.output_config).toBeUndefined();
  });
});
