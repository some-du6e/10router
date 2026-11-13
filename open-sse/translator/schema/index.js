// Translator schema barrel — pure data enums (roles, blocks). No logic here.
export { ROLE, GEMINI_ROLE } from "./roles.js";
export {
  OPENAI_BLOCK, CLAUDE_BLOCK, CLAUDE_TOOL_REF, RESPONSES_ITEM, RESPONSES_ITEM_ID_PREFIX, RESPONSES_STATUS, TOOL_TYPE, TOOL_CHOICE,
  VALID_OPENAI_CONTENT_TYPES, VALID_OPENAI_MESSAGE_TYPES,
} from "./blocks.js";
export { OPENAI_FINISH, CLAUDE_STOP, GEMINI_FINISH, RESPONSES_INCOMPLETE_REASON } from "./finishReasons.js";
export { MODEL_FALLBACK, DEFAULT_IMAGE_MIME } from "./defaults.js";
