function json(value) {
  return typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2) || "";
}

export function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return json(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block) return "";
      if (block.type === "tool_use")
        return `Tool call: ${block.name}\n${json(block.input)}`;
      if (block.type === "tool_result")
        return `Tool result: ${block.tool_use_id}\n${contentText(block.content)}`;
      if (block.functionCall)
        return `Tool call: ${block.functionCall.name}\n${json(block.functionCall.args)}`;
      if (block.functionResponse)
        return `Tool result: ${block.functionResponse.name}\n${json(block.functionResponse.response)}`;
      if (block.text != null) return block.text;
      if (block.thinking != null) return `Thinking\n${block.thinking}`;
      if (
        ["image", "image_url", "input_image"].includes(block.type) ||
        block.inlineData ||
        block.fileData
      )
        return "[Image or attachment]";
      return json(block);
    })
    .filter(Boolean)
    .join("\n\n");
}

export function getRequestConversation(payload) {
  if (!payload || payload.redacted) return { messages: [], tools: [] };
  const request = payload._structuredPreview || payload;
  const messages = [];
  const add = (role, content, raw, name = "") => {
    messages.push({
      role,
      text: contentText(content),
      raw,
      name,
      index: messages.length,
    });
  };
  const system =
    request.system ?? request.instructions ?? request.systemInstruction?.parts;
  if (system) add("system", system, system);
  const input =
    request.messages ?? request.input ?? request.contents ?? request.prompt;
  if (typeof input === "string") add("user", input, input);
  if (Array.isArray(input)) {
    for (const message of input) {
      if (!message || typeof message !== "object") {
        add("user", message, message);
        continue;
      }
      if (message.type === "reasoning") {
        add(
          "assistant",
          contentText(message.summary) || "[Reasoning content not available]",
          message,
          "Reasoning",
        );
      } else if (message.type === "custom_tool_call") {
        add(
          "assistant",
          `Tool call: ${message.name}\n${json(message.input)}`,
          message,
          message.name,
        );
      } else if (message.type === "function_call") {
        add(
          "assistant",
          `Tool call: ${message.name}\n${json(message.arguments)}`,
          message,
          message.name,
        );
      } else if (
        ["function_call_output", "custom_tool_call_output"].includes(
          message.type,
        )
      ) {
        add("tool", message.output, message, message.call_id);
      } else {
        const role =
          message.role === "model" ? "assistant" : message.role || "user";
        const blocks = message.content ?? message.parts ?? message.text;
        // Claude and Gemini embed tool results inside messages with a user role.
        const results = Array.isArray(blocks)
          ? blocks.filter(
              (b) => b?.type === "tool_result" || b?.functionResponse,
            )
          : [];
        const other = results.length
          ? blocks.filter((b) => !results.includes(b))
          : blocks;
        let text = contentText(other);
        const calls =
          message.tool_calls ||
          (message.function_call ? [message.function_call] : []);
        for (const call of calls) {
          const fn = call.function || call;
          text += `${text ? "\n\n" : ""}Tool call: ${fn.name || call.type}\n${json(fn.arguments ?? fn.input)}`;
        }
        if (text || !results.length)
          add(role, text, message, message.name || message.tool_call_id);
        for (const result of results)
          add(
            "tool",
            [result],
            result,
            result.tool_use_id || result.functionResponse?.name,
          );
      }
    }
  }
  const tools = (Array.isArray(request.tools) ? request.tools : [])
    .filter((tool) => tool && typeof tool === "object")
    .flatMap((tool) => tool.functionDeclarations || [tool])
    .filter((tool) => tool && typeof tool === "object")
    .map((tool, index) => {
      const fn = tool.function || tool;
      return {
        role: "definition",
        name: fn.name || tool.type || `Tool ${index + 1}`,
        text: [fn.description, json(fn.parameters ?? fn.input_schema ?? tool)]
          .filter(Boolean)
          .join("\n\n"),
        raw: tool,
        index,
      };
    });
  return { messages, tools };
}

export function getConversation(request, response) {
  const conversation = getRequestConversation(request);
  if (!response || response.redacted || request?.redacted) return conversation;
  const reply = response._structuredPreview || response;
  const input = [];
  if (reply.thinking)
    input.push({ type: "reasoning", summary: reply.thinking });
  if (reply.content || reply.tool_calls?.length)
    input.push({
      role: "assistant",
      content: reply.content,
      tool_calls: reply.tool_calls,
    });
  const output = getRequestConversation({ input }).messages;
  if (!output.length && response._truncated)
    output.push({ role: "assistant", text: "[Response truncated. See Debug for the stored preview.]", raw: response });
  for (const message of output)
    conversation.messages.push({
      ...message,
      name: message.name ? `Response: ${message.name}` : "Response",
      index: conversation.messages.length,
    });
  return conversation;
}

const PREVIEW_PRESERVE_KEYS = new Set([
  "role",
  "type",
  "name",
  "id",
  "call_id",
  "tool_call_id",
  "tool_use_id",
]);
const TRUNCATED_SUFFIX = "\n[Content truncated]";

function shortenPreview(item, limit, key = "") {
  if (typeof item === "string")
    return PREVIEW_PRESERVE_KEYS.has(key) || item.length <= limit
      ? item
      : `${item.slice(0, limit)}${TRUNCATED_SUFFIX}`;
  if (Array.isArray(item)) return item.map((child) => shortenPreview(child, limit));
  if (item && typeof item === "object")
    return Object.fromEntries(
      Object.entries(item).map(([k, child]) => [k, shortenPreview(child, limit, k)]),
    );
  return item;
}

function isOmitted(value) {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

// Serialized length of shortenPreview(value, limit) for every limit in one walk,
// without building the copies. Returns null (fully over budget), the sizes
// array, or undefined when the value holds something only the slow path handles.
function measurePreviewSizes(value, limits, maxSize) {
  const sizes = new Array(limits.length).fill(0);
  let unsupported = false;
  const addAll = (n) => { for (let k = 0; k < sizes.length; k++) sizes[k] += n; };
  const overBudget = () => sizes.every((size) => size > maxSize);
  const walk = (item, key) => {
    if (unsupported || overBudget()) return;
    if (typeof item === "string") {
      if (PREVIEW_PRESERVE_KEYS.has(key)) return addAll(JSON.stringify(item).length);
      let full = -1;
      for (let k = 0; k < limits.length; k++) {
        if (item.length <= limits[k]) {
          if (full < 0) full = JSON.stringify(item).length;
          sizes[k] += full;
        } else {
          sizes[k] += JSON.stringify(`${item.slice(0, limits[k])}${TRUNCATED_SUFFIX}`).length;
        }
      }
      return;
    }
    if (item === null || typeof item === "number" || typeof item === "boolean")
      return addAll(JSON.stringify(item).length);
    if (Array.isArray(item)) {
      addAll(2 + Math.max(0, item.length - 1));
      for (let i = 0; i < item.length; i++) {
        if (isOmitted(item[i])) addAll(4);
        else walk(item[i], "");
      }
      return;
    }
    const proto = item && typeof item === "object" ? Object.getPrototypeOf(item) : undefined;
    // An own toJSON (even a method, which isOmitted would drop) changes what gets serialized.
    if ((proto !== Object.prototype && proto !== null) || Object.hasOwn(item, "toJSON")) { unsupported = true; return; }
    const entries = Object.entries(item).filter(([, child]) => !isOmitted(child));
    addAll(2 + Math.max(0, entries.length - 1));
    for (const [k, child] of entries) {
      addAll(JSON.stringify(k).length + 1);
      walk(child, k);
    }
  };
  walk(value, "");
  if (unsupported) return undefined;
  return overBudget() ? null : sizes;
}

// Retain JSON structure within the existing storage budget, instead of cutting
// a JSON string mid-message. Small identity fields stay intact for navigation.
export function structuredPreview(value, maxSize) {
  const limits = [];
  for (let limit = Math.min(maxSize, 8192); limit >= 32; limit = Math.floor(limit / 2))
    limits.push(limit);
  // Measure first so large bodies are not deep-copied and re-serialized once per limit.
  const sizes = measurePreviewSizes(value, limits, maxSize);
  if (sizes === null) return null;
  if (sizes) {
    const k = sizes.findIndex((size) => size <= maxSize);
    const preview = shortenPreview(value, limits[k]);
    if (JSON.stringify(preview).length === sizes[k]) return preview;
  }
  for (const limit of limits) {
    const preview = shortenPreview(value, limit);
    if (JSON.stringify(preview).length <= maxSize) return preview;
  }
  return null;
}

export const __test__ = { measurePreviewSizes };
