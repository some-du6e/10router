import { OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { CLAUDE_INTERRUPTED_TOOL_RESULT_TEXT, CLAUDE_PREFILL_CONTINUATION_TEXT } from "../../config/claudeMessageCompat.js";

// Content of the user turn that follows a Claude assistant turn left last: an
// interrupted tool_result for each tool_use it ends with (Anthropic rejects a
// tool_use without its result), else "Continue.".
export function claudeContinuationContent(assistantMsg) {
  const toolUses = Array.isArray(assistantMsg?.content)
    ? assistantMsg.content.filter(block => block?.type === CLAUDE_BLOCK.TOOL_USE && block.id)
    : [];
  return toolUses.length > 0
    ? toolUses.map(block => ({
      type: CLAUDE_BLOCK.TOOL_RESULT,
      tool_use_id: block.id,
      content: CLAUDE_INTERRUPTED_TOOL_RESULT_TEXT,
      is_error: true,
    }))
    : [{ type: CLAUDE_BLOCK.TEXT, text: CLAUDE_PREFILL_CONTINUATION_TEXT }];
}

// Collapse text-only content-part arrays while preserving multimodal structure.
export function collapseTextParts(parts) {
  const canCollapse = parts.length > 0
    && parts.every((part) => part.type === OPENAI_BLOCK.TEXT)
    && !parts.some((part) => part.cache_control);

  return canCollapse
    ? parts.map((part) => part.text || "").join("\n")
    : parts;
}
