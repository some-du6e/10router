// Claude model-specific message compatibility.
// Keep wire-shape exceptions here rather than scattering model checks through translators.
const NO_ASSISTANT_PREFILL_MODELS = /^claude-opus-5(?:$|-)/i;

export function supportsClaudeAssistantPrefill(model = "") {
  const baseModel = String(model).split("/").pop();
  return !NO_ASSISTANT_PREFILL_MODELS.test(baseModel);
}

export const CLAUDE_PREFILL_CONTINUATION_TEXT = "Continue.";
export const CLAUDE_INTERRUPTED_TOOL_RESULT_TEXT =
  "Tool execution was interrupted before a result was returned.";

// Top-level Messages body fields that only exist behind an anthropic-beta flag.
// When an endpoint has that flag dropped, the field goes too: strict gateways
// (Snowflake Cortex) 400 with "context_management: Extra inputs are not permitted".
export const CLAUDE_BETA_BODY_FIELDS = {
  "context-management-2025-06-27": ["context_management"],
};
