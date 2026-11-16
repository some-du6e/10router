import { describe, expect, it, vi } from "vitest";

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

  it("keeps the untruncated payload alongside a truncated preview", async () => {
    const big = { messages: [{ role: "system", content: "x".repeat(20000) }] };
    const record = {
      request: requestDetailsTest.truncateField(big, 5 * 1024),
      response: requestDetailsTest.truncateField({ ok: true }, 5 * 1024),
    };
    expect(record.request._truncated).toBe(true);
    const packed = await requestDetailsTest.packFullData({ request: big, response: { ok: true } }, record);
    expect(await requestDetailsTest.unpackFullData(packed)).toEqual({ request: big });
    expect(await requestDetailsTest.packFullData({ response: { ok: true } }, { response: { ok: true } })).toBeNull();
    expect(await requestDetailsTest.unpackFullData(null)).toBeNull();
    await expect(requestDetailsTest.unpackFullData("not gzip")).rejects.toThrow();
  });

  it("reuses the compact JSON from truncation instead of serializing the full payload again", async () => {
    const big = { messages: [{ role: "user", content: "x".repeat(200 * 1024) }] };
    const fieldJson = {};
    const record = { request: requestDetailsTest.truncateField(big, 5 * 1024, fieldJson, "request") };
    expect(fieldJson.request).toBe(JSON.stringify(big));
    const stringify = vi.spyOn(JSON, "stringify");
    const packed = await requestDetailsTest.packFullData({ request: big }, record, fieldJson);
    const large = stringify.mock.calls.filter(([value]) => value === big || value?.request === big).length;
    stringify.mockRestore();
    expect(large).toBe(0);
    expect(await requestDetailsTest.unpackFullData(packed)).toEqual({ request: big });
  });

  it("measures the full payload limit in bytes, not characters", async () => {
    // 6M three-byte chars: under 16 MB as string length, over it as UTF-8.
    const big = { messages: [{ role: "user", content: "€".repeat(6 * 1024 * 1024) }] };
    const record = { request: requestDetailsTest.truncateField(big, 5 * 1024) };
    expect(record.request._truncated).toBe(true);
    expect(await requestDetailsTest.packFullData({ request: big }, record)).toBeNull();
  });

  it("skips payloads whose truncated size already exceeds the limit", async () => {
    const record = { request: { _truncated: true, _originalSize: 17 * 1024 * 1024 } };
    const item = { request: { toJSON() { throw new Error("should not serialize"); } } };
    expect(await requestDetailsTest.packFullData(item, record)).toBeNull();
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

  it("keeps the reasoning effort the client sent", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(extractRequestConfig({
      model: "claude-sonnet-x", messages, thinking: { type: "adaptive" }, output_config: { effort: "max" },
    }, true)).toEqual({
      model: "claude-sonnet-x", stream: true, messages, thinking: { type: "adaptive" }, output_config: { effort: "max" },
    });
    expect(extractRequestConfig({ model: "gpt-x", messages, reasoning_effort: "low" }, false))
      .toEqual({ model: "gpt-x", stream: false, messages, reasoning_effort: "low" });
    expect(extractRequestConfig({ model: "qwen-x", messages, enable_thinking: true, thinking_budget: 2048 }, false))
      .toEqual({ model: "qwen-x", stream: false, messages, enable_thinking: true, thinking_budget: 2048 });
  });

  it("copies the params, so editing the body afterwards doesn't change the record", () => {
    const body = { model: "claude-sonnet-x", messages: [], output_config: { effort: "low" }, thinking: { type: "adaptive" } };
    const config = extractRequestConfig(body, true);
    delete body.output_config.effort;
    body.thinking.type = "enabled";
    expect(config.output_config).toEqual({ effort: "low" });
    expect(config.thinking).toEqual({ type: "adaptive" });
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
