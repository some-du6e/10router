// Ids of the Responses output items 10router makes up. The live Chat → Responses
// stream, the non-streaming Responses body and its SSE replay all use these, so
// one reply gets the same item ids whichever way it reaches the client.
import { RESPONSES_ITEM_ID_PREFIX } from "../schema/index.js";

// A message or reasoning item: prefix + response id + Chat choice index.
export const responsesItemId = (prefix, responseId, index) => `${prefix}_${responseId}_${index}`;

// A function_call or custom_tool_call item: prefix + call id.
export const toolCallItemId = (custom, callId) =>
  `${custom ? RESPONSES_ITEM_ID_PREFIX.CUSTOM_TOOL_CALL : RESPONSES_ITEM_ID_PREFIX.FUNCTION_CALL}_${callId}`;
