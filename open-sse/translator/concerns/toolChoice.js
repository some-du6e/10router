// Anthropic rejects a forced tool while thinking is on: "Thinking may not be
// enabled when tool_choice forces tool use." Codex sends a reasoning effort on
// every request, so a forced tool_choice plus that effort would 400 on every
// thinking-capable Claude model. Thinking is kept and the choice becomes auto.
import { getCapabilitiesForModel } from "../../providers/capabilities.js";

const CLAUDE_FORCED = new Set(["any", "tool"]);
const CLAUDE_THINKING_ON = new Set(["enabled", "adaptive"]);
const THINKING_OFF = "disabled";
const EFFORT_OFF = "none";

// A Claude model that always thinks (permanently adaptive): it takes no
// `thinking` field, so the body alone doesn't show that thinking is on.
function alwaysThinks(provider, model) {
  const caps = getCapabilitiesForModel(provider, model);
  return !!caps?.reasoning && !!caps.thinkingFormat?.startsWith("claude") && caps.thinkingCanDisable === false;
}

function isClaudeModel(provider, model) {
  return !!getCapabilitiesForModel(provider, model)?.thinkingFormat?.startsWith("claude");
}

// Claude Messages body, after thinking is final.
export function relaxForcedToolChoiceForThinking(body, provider = null) {
  if (!body || typeof body !== "object") return body;
  const choice = body.tool_choice;
  if (!CLAUDE_FORCED.has(choice?.type)) return body;
  const thinking = CLAUDE_THINKING_ON.has(body.thinking?.type)
    || (body.thinking?.type !== THINKING_OFF && alwaysThinks(provider, body.model));
  if (!thinking) return body;
  body.tool_choice = {
    type: "auto",
    ...(choice.disable_parallel_tool_use !== undefined ? { disable_parallel_tool_use: choice.disable_parallel_tool_use } : {}),
  };
  return body;
}

// Chat Completions body for a Claude model behind a Chat endpoint: the gateway
// turns the effort into Claude thinking and gets the same rejection.
export function relaxForcedChatToolChoiceForClaude(body, provider, model) {
  if (!body || typeof body !== "object") return body;
  const choice = body.tool_choice;
  const forced = choice === "required" || (choice && typeof choice === "object" && choice.type === "function");
  if (!forced || !isClaudeModel(provider, model)) return body;
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  const thinking = (typeof effort === "string" && effort !== EFFORT_OFF)
    || CLAUDE_THINKING_ON.has(body.thinking?.type)
    || alwaysThinks(provider, model);
  if (thinking) body.tool_choice = "auto";
  return body;
}
