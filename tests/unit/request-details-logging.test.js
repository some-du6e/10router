import { describe, expect, it } from "vitest";

import { extractRequestConfig } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { __test__ as requestDetailsTest } from "../../src/lib/db/repos/requestDetailsRepo.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

async function runResponsesStream(input, onStreamComplete) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = stream.pipeThrough(createSSETransformStreamWithLogger(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI_RESPONSES,
    "codex",
    null,
    null,
    "gpt-5.6-luna",
    null,
    null,
    onStreamComplete,
  ));

  const reader = output.getReader();
  while (!(await reader.read()).done) {}
}

describe("request detail logging", () => {
  it("keeps full payload retention opt-in", () => {
    expect(requestDetailsTest.getMaxJsonSize({
      showSensitiveRequestDetails: false,
      observabilityMaxJsonSize: 5,
    })).toBe(5 * 1024);
    expect(requestDetailsTest.getMaxJsonSize({
      showSensitiveRequestDetails: true,
      observabilityMaxJsonSize: 5,
    })).toBe(128 * 1024);
  });

  it("keeps Responses API input instead of replacing it with empty messages", () => {
    const input = [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Explain this request" }],
    }];

    expect(extractRequestConfig({
      model: "gpt-5.6-luna",
      input,
      instructions: "Be concise",
      stream: true,
    }, true)).toEqual({
      model: "gpt-5.6-luna",
      input,
      instructions: "Be concise",
      stream: true,
    });
  });

  it("captures Responses API text and tool calls when a stream completes", async () => {
    let completed;
    await runResponsesStream([
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "event: response.output_item.done",
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" } })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`,
      "",
    ].join("\n"), (content) => {
      completed = content;
    });

    expect(completed.content).toBe("hello");
    expect(completed.toolCalls).toEqual([{
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: "{}",
    }]);
  });
});
