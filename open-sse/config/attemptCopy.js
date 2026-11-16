// What each attempt at a client request (one account, one combo model) gets its
// own copy of. The account and combo loops reuse the client's body for the next
// attempt, and translators and executors edit these objects in place.
// Strings and anything deeper than listed here stay shared, so a long history
// isn't cloned per attempt.

// Thinking settings: deep-copied for each attempt and for request details.
export const THINKING_OBJECT_KEYS = ["thinking", "reasoning", "output_config"];

// History lists (Chat/Claude messages, Responses input, Gemini contents): a new
// array with each item shallow-copied.
export const HISTORY_KEYS = ["messages", "input", "contents"];

// An item's own lists (a message's content blocks, Gemini parts, a tool call's
// output, tool_calls): a new array with each element shallow-copied. Copied on
// history items and on the objects in NESTED_ITEM_KEYS.
export const ITEM_LIST_KEYS = ["content", "parts", "output", "tool_calls"];

// Lists of objects next to the history: a new array with each element shallow-copied.
export const OBJECT_LIST_KEYS = ["system", "tools"];

// Single objects copied like a history item: Gemini's settings and system instruction.
export const NESTED_ITEM_KEYS = ["generationConfig", "systemInstruction", "system_instruction"];

// Gemini CLI / Antigravity wrap the Gemini body in this envelope, which is
// copied with the same rules.
export const ENVELOPE_KEY = "request";
