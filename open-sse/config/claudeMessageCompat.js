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

// Beta flags for Anthropic's own API only, with the body fields they unlock.
// Third-party hosts lose the flag, and the field goes out only with its flag.
// safeguards is Claude Code's auto-mode classifier input (permission rules,
// paths, git state); strict gateways 400 with "safeguards: Extra inputs are
// not permitted".
export const CLAUDE_FIRST_PARTY_BETA_FIELDS = {
  "dangerous-tool-use-2026-09-03": ["safeguards"],
};

// Top-level Messages body fields that only exist behind an anthropic-beta flag.
// When an endpoint has that flag dropped, the field goes too: strict gateways
// (Snowflake Cortex) 400 with "context_management: Extra inputs are not permitted".
export const CLAUDE_BETA_BODY_FIELDS = {
  "context-management-2025-06-27": ["context_management"],
  ...CLAUDE_FIRST_PARTY_BETA_FIELDS,
};

// thinking.display values that work without a beta flag. "updates" needs
// thinking-display-updates-2026-08-18, which not every route forwards, so it
// isn't carried onto a rewritten adaptive thinking block.
export const CLAUDE_GA_THINKING_DISPLAYS = new Set(["summarized", "omitted"]);
