// A forced tool_choice ("any"/"tool" on Claude, "required"/{type:"function"} on
// Chat) that the Claude model behind the request would reject with a 400 is
// sent as auto instead, so the request still runs:
// - Opus/Sonnet 5.5 and Fable/Mythos 5.1 reject a forced tool whatever the
//   thinking setting (capability forcedToolChoice: false);
// - Claude 4.x rejects one while thinking is on ("Thinking may not be enabled
//   when tool_choice forces tool use"; forcedToolChoiceWithThinking: false, and
//   every claude-budget model).
// Fable 5, Mythos 5, Opus 5, Sonnet 5 and Haiku 5.5 accept a forced tool, thinking
// or not. Only Claude models are touched: other models on Claude-format or Chat
// endpoints (GLM, Kimi, MiniMax, DeepSeek, ...) keep the choice as sent.
import { getCapabilitiesForModel } from "../../providers/capabilities.js";

const CLAUDE_FORCED = new Set(["any", "tool"]);
const THINKING_ON = new Set(["enabled", "adaptive"]);
const EFFORT_OFF = "none";
const AUTO = "auto";

const RULE = { NONE: 0, ALWAYS: 1, WITH_THINKING: 2 };

function forcedToolRule(provider, model) {
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps?.thinkingFormat?.startsWith("claude")) return RULE.NONE;
  if (caps.forcedToolChoice === false) return RULE.ALWAYS;
  if (caps.forcedToolChoiceWithThinking === false || caps.thinkingFormat === "claude-budget") return RULE.WITH_THINKING;
  return RULE.NONE;
}

// Claude Messages body. Run it once thinking is final: at the end of
// prepareClaudeRequest, and on the outgoing body in DefaultExecutor.finalizeBody.
export function relaxForcedToolChoiceForThinking(body, provider = null) {
  if (!body || typeof body !== "object") return body;
  const choice = body.tool_choice;
  if (!CLAUDE_FORCED.has(choice?.type)) return body;
  const rule = forcedToolRule(provider, body.model);
  const reject = rule === RULE.ALWAYS || (rule === RULE.WITH_THINKING && THINKING_ON.has(body.thinking?.type));
  if (!reject) return body;
  body.tool_choice = {
    type: AUTO,
    ...(choice.disable_parallel_tool_use !== undefined ? { disable_parallel_tool_use: choice.disable_parallel_tool_use } : {}),
  };
  return body;
}

// Chat Completions body for a Claude model behind a Chat endpoint, whose gateway
// turns a reasoning effort into Claude thinking. With `thinkingIsFinal` false
// (translateRequest, before an executor may strip reasoning fields) only the
// thinking-independent rule applies; DefaultExecutor.finalizeBody passes true
// on the outgoing body.
export function relaxForcedChatToolChoiceForClaude(body, provider, model, thinkingIsFinal = true) {
  if (!body || typeof body !== "object") return body;
  const choice = body.tool_choice;
  const forced = choice === "required" || (choice && typeof choice === "object" && choice.type === "function");
  if (!forced) return body;
  const rule = forcedToolRule(provider, model || body.model);
  if (rule === RULE.NONE) return body;
  if (rule === RULE.WITH_THINKING) {
    if (!thinkingIsFinal) return body;
    const effort = body.reasoning_effort ?? body.reasoning?.effort;
    const thinking = (typeof effort === "string" && effort !== EFFORT_OFF) || THINKING_ON.has(body.thinking?.type);
    if (!thinking) return body;
  }
  body.tool_choice = AUTO;
  return body;
}
