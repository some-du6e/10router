import { IMAGE_TOKEN_ESTIMATE } from "open-sse/config/mediaConfig.js";
import { readJsonObject } from "@/sse/utils/requestBody.js";

const CHARS_PER_TOKEN = 4;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

function countValueChars(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countValueChars(item), 0);
  }
  if (typeof value === "object") {
    return Object.entries(value).reduce((total, [key, item]) => {
      return total + key.length + countValueChars(item);
    }, 0);
  }
  return 0;
}

function countContentBlockChars(block) {
  if (block == null) return 0;
  if (typeof block === "string") return block.length;
  if (typeof block !== "object") return countValueChars(block);

  switch (block.type) {
    case "text":
      return countValueChars(block.text);
    case "image":
      // An image costs about the same whatever its size, not its base64 length.
      return IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
    case "tool_use":
      return countValueChars(block.name) + countValueChars(block.input);
    case "tool_result":
      return Array.isArray(block.content)
        ? block.content.reduce((total, item) => total + countContentBlockChars(item), 0)
        : countValueChars(block.content);
    case "thinking":
      return countValueChars(block.thinking);
    default:
      return countValueChars(block);
  }
}

function countMessageChars(message) {
  if (!message || typeof message !== "object") return 0;
  const content = message.content;

  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, block) => total + countContentBlockChars(block), 0);
  }
  return countValueChars(content);
}

export function estimateAnthropicInputTokens(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = countValueChars(body.system) + countValueChars(body.tools);

  for (const msg of messages) {
    totalChars += countMessageChars(msg);
  }

  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * POST /v1/messages/count_tokens - Mock token count response
 */
export async function POST(request) {
  const { body, error } = await readJsonObject(request, { logTag: "COUNT_TOKENS" });
  if (error) return error;

  const inputTokens = estimateAnthropicInputTokens(body);

  return new Response(JSON.stringify({
    input_tokens: inputTokens
  }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

