// Shared SSE primitives (only import-free modules → safe for executors + stream.js)
import { FORMATS } from "../translator/formats.js";

export const SSE_DONE = "data: [DONE]\n\n";

// Comment line: every SSE parser ignores it, but it counts as traffic to proxies.
export const SSE_KEEPALIVE = ": keepalive\n\n";

// Keepalive for a JSON reply whose headers went out before its body was ready:
// whitespace before a JSON value is valid JSON, so every parser skips it.
export const JSON_KEEPALIVE = "\n";

// Client formats whose SSE parsers skip comment lines (OpenAI SDK, Anthropic SDK,
// Codex), and whose error bodies an early JSON reply knows how to write.
// Everything else gets no keepalive until its parser is checked.
export const KEEPALIVE_FORMATS = new Set([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES]);

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive"
};

// Variant for web-cookie executors behind nginx (disable proxy buffering)
export const SSE_HEADERS_NO_BUFFER = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no"
};

// Variant for client-facing SSE responses (adds permissive CORS)
export const SSE_HEADERS_CORS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*"
};

// Client-facing JSON reply whose body is written later (early headers).
export const JSON_HEADERS_CORS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-cache",
  "Access-Control-Allow-Origin": "*"
};
