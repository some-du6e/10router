// Chat Completions JSON body → OpenAI Responses body, for a Responses client
// (Codex) whose non-streaming request went to a Chat, Claude, Gemini or Ollama
// upstream. The non-streaming and forced-SSE-to-JSON paths both use it.
import { ROLE, RESPONSES_ITEM, RESPONSES_STATUS } from "../../translator/schema/index.js";
import { customToolInput } from "../../translator/concerns/toolCall.js";
import { clientToolFields } from "../../translator/concerns/toolNamespace.js";
import { toResponsesIncompleteReason } from "../../translator/concerns/finishReason.js";

/**
 * @param {object} responseBody Chat Completions body (`choices[0].message`)
 * @param {Set<string>|null} customToolNames wire names of custom (freeform) tools
 * @param {Map<string, {namespace: string|null, name: string}>|null} toolNamespaces
 */
export function chatCompletionToResponses(responseBody, customToolNames = null, toolNamespaces = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // Reasoning → a reasoning item (summary text), mirroring the streaming path.
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  // Assistant text → a message item with output_text content.
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  // tool_calls → function_call/custom_tool_call items under the client's name and namespace.
  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = !!customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      ...clientToolFields(toolNamespaces, fn.name || ""),
      ...(custom
        ? { input: customToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const incompleteReason = toResponsesIncompleteReason(choice.finish_reason);
  const usage = responseBody.usage || {};
  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || "unknown",
    status: incompleteReason ? RESPONSES_STATUS.INCOMPLETE : RESPONSES_STATUS.COMPLETED,
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}
