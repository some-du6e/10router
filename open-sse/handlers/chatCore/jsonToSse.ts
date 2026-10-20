// Replays a finished client-format JSON reply as that format's SSE stream, for
// a client that asked to stream when the upstream answered with plain JSON.
// Returns null for formats it cannot replay; the caller then sends the JSON.
import { FORMATS } from "../../translator/formats.js";

type Json = Record<string, any>;

const sse = (data: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

function openAIEvents(body: Json): string {
  const base = { id: body.id, object: "chat.completion.chunk", created: body.created, model: body.model };
  const out: string[] = [];
  for (const choice of body.choices || []) {
    const msg = choice.message || {};
    const delta: Json = { role: msg.role || "assistant" };
    if (msg.reasoning_content) delta.reasoning_content = msg.reasoning_content;
    if (msg.content != null) delta.content = msg.content;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      delta.tool_calls = msg.tool_calls.map((tc: Json, index: number) => ({ index, ...tc }));
    }
    out.push(sse({ ...base, choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] }));
    out.push(sse({ ...base, choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }] }));
  }
  if (body.usage) out.push(sse({ ...base, choices: [], usage: body.usage }));
  out.push("data: [DONE]\n\n");
  return out.join("");
}

function claudeEvents(body: Json): string {
  const ev = (data: Json) => sse(data, data.type);
  const usage = body.usage || {};
  const out = [ev({ type: "message_start", message: { ...body, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } })];
  (body.content || []).forEach((block: Json, index: number) => {
    if (block.type === "text") {
      out.push(ev({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      out.push(ev({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text || "" } }));
    } else if (block.type === "thinking") {
      out.push(ev({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }));
      out.push(ev({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking || "" } }));
      if (block.signature) out.push(ev({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }));
    } else if (block.type === "tool_use") {
      out.push(ev({ type: "content_block_start", index, content_block: { ...block, input: {} } }));
      out.push(ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } }));
    } else {
      out.push(ev({ type: "content_block_start", index, content_block: block }));
    }
    out.push(ev({ type: "content_block_stop", index }));
  });
  out.push(ev({ type: "message_delta", delta: { stop_reason: body.stop_reason ?? "end_turn", stop_sequence: body.stop_sequence ?? null }, usage }));
  out.push(ev({ type: "message_stop" }));
  return out.join("");
}

function responsesEvents(body: Json): string {
  let seq = 0;
  const ev = (data: Json) => sse({ ...data, sequence_number: seq++ }, data.type);
  const out = [
    ev({ type: "response.created", response: { ...body, status: "in_progress", output: [] } }),
    ev({ type: "response.in_progress", response: { ...body, status: "in_progress", output: [] } }),
  ];
  (body.output || []).forEach((item: Json, output_index: number) => {
    out.push(ev({ type: "response.output_item.added", output_index, item }));
    if (item.type === "message") {
      (item.content || []).forEach((part: Json, content_index: number) => {
        if (part.type !== "output_text") return;
        out.push(ev({ type: "response.output_text.delta", item_id: item.id, output_index, content_index, delta: part.text || "" }));
        out.push(ev({ type: "response.output_text.done", item_id: item.id, output_index, content_index, text: part.text || "" }));
      });
    } else if (item.type === "function_call") {
      out.push(ev({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments || "" }));
      out.push(ev({ type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments || "" }));
    }
    out.push(ev({ type: "response.output_item.done", output_index, item }));
  });
  out.push(ev({ type: "response.completed", response: { ...body, status: body.status || "completed" } }));
  return out.join("");
}

export function jsonReplyToSse(body: unknown, sourceFormat: string): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Json;
  if (sourceFormat === FORMATS.CLAUDE && b.type === "message") return claudeEvents(b);
  if (sourceFormat === FORMATS.OPENAI_RESPONSES && b.object === "response") return responsesEvents(b);
  if (sourceFormat === FORMATS.OPENAI && Array.isArray(b.choices)) return openAIEvents(b);
  return null;
}
