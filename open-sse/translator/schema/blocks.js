// Content-block "type" discriminators — fixed per format. Pure data (no logic).

// OpenAI chat content blocks + tool_call wrapper.
export const OPENAI_BLOCK = {
  TEXT: "text",
  IMAGE_URL: "image_url",
  IMAGE: "image",
  INPUT_AUDIO: "input_audio",
  AUDIO_URL: "audio_url",
  FILE: "file",
  FUNCTION: "function",
};

// Claude content blocks.
export const CLAUDE_BLOCK = {
  TEXT: "text",
  IMAGE: "image",
  DOCUMENT: "document",
  TOOL_USE: "tool_use",
  TOOL_RESULT: "tool_result",
  THINKING: "thinking",
  REDACTED_THINKING: "redacted_thinking",
  WEB_SEARCH_TOOL: "web_search_20250305",
  SERVER_TOOL_USE: "server_tool_use",
  WEB_SEARCH_TOOL_RESULT: "web_search_tool_result",
  // Mid-conversation tool changes, carried by a role "system" message in messages[].
  TOOL_ADDITION: "tool_addition",
  TOOL_REMOVAL: "tool_removal",
};

// How a tool_addition / tool_removal names its tool (block.tool.type).
export const CLAUDE_TOOL_REF = {
  REFERENCE: "tool_reference",
  DEFINITION: "tool_definition",
};

// OpenAI Responses API item types.
export const RESPONSES_ITEM = {
  MESSAGE: "message",
  FUNCTION_CALL: "function_call",
  FUNCTION_CALL_OUTPUT: "function_call_output",
  CUSTOM_TOOL_CALL: "custom_tool_call",
  CUSTOM_TOOL_CALL_OUTPUT: "custom_tool_call_output",
  ADDITIONAL_TOOLS: "additional_tools",
  REASONING: "reasoning",
  OUTPUT_TEXT: "output_text",
  INPUT_TEXT: "input_text",
  INPUT_IMAGE: "input_image",
  SUMMARY_TEXT: "summary_text",
  NAMESPACE: "namespace",
};

// Prefixes of the output item ids 10router makes up (`msg_…`, `rs_…`, `fc_…`, `ctc_…`).
export const RESPONSES_ITEM_ID_PREFIX = {
  MESSAGE: "msg",
  REASONING: "rs",
  FUNCTION_CALL: "fc",
  CUSTOM_TOOL_CALL: "ctc",
};

// Tool choice values shared by Chat Completions and Claude.
export const TOOL_CHOICE = {
  AUTO: "auto",
  NONE: "none",
  REQUIRED: "required", // Chat: call some tool
  ANY: "any",           // Claude: call some tool
  TOOL: "tool",         // Claude: call the named tool
};

// OpenAI Responses `status` values, on a response and on its output items.
export const RESPONSES_STATUS = {
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  INCOMPLETE: "incomplete",
};

// Tool declaration `type` values for client-defined tools.
export const TOOL_TYPE = {
  FUNCTION: OPENAI_BLOCK.FUNCTION,
  CUSTOM: "custom",
};

// Valid OpenAI block types (used by filterToOpenAIFormat).
export const VALID_OPENAI_CONTENT_TYPES = [
  OPENAI_BLOCK.TEXT, OPENAI_BLOCK.IMAGE_URL, OPENAI_BLOCK.IMAGE, OPENAI_BLOCK.INPUT_AUDIO, OPENAI_BLOCK.AUDIO_URL, OPENAI_BLOCK.FILE,
];
export const VALID_OPENAI_MESSAGE_TYPES = [
  OPENAI_BLOCK.TEXT, OPENAI_BLOCK.IMAGE_URL, OPENAI_BLOCK.IMAGE, "tool_calls", CLAUDE_BLOCK.TOOL_RESULT,
];
