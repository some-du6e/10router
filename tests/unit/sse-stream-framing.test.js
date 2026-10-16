import { describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

async function runStream(input, options = {}) {
  const onStreamComplete = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  }).pipeThrough(createSSEStream({
    mode: "passthrough",
    provider: "openai",
    ...options,
    onStreamComplete,
  }));
  return { text: await new Response(stream).text(), onStreamComplete };
}

describe("SSE framing and EOF use the same processing path", () => {
  it.each(["\n\n", ""])("emits one DONE sentinel when the upstream ends with %j", async (ending) => {
    const { text } = await runStream(`data: [DONE]${ending}`);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(text).toMatch(/data: \[DONE\]\n\n$/);
  });

  it("normalizes and records a passthrough content tail without a newline", async () => {
    const chunk = { id: "chat", choices: [{ delta: { content: "hello", tool_calls: [] } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } };
    const { text, onStreamComplete } = await runStream(`data:${JSON.stringify(chunk)}`);
    const parsed = JSON.parse(text.split("\n")[0].slice(6));
    expect(parsed.object).toBe("chat.completion.chunk");
    expect(parsed.created).toEqual(expect.any(Number));
    expect(parsed.id).toMatch(/^chatcmpl-/);
    expect(parsed.choices[0].delta).toEqual({ content: "hello" });
    expect(onStreamComplete).toHaveBeenCalledWith(
      { content: "hello", thinking: "", toolCalls: [] },
      expect.objectContaining({ prompt_tokens: 11, completion_tokens: 7 }),
      expect.any(Number),
    );
  });

  it("drops a malformed passthrough tail just like a newline-terminated line", async () => {
    const { text } = await runStream("data: upstream returned HTML");
    expect(text).toBe("data: [DONE]\n\n");
  });

  it("does not fabricate response.failed after a terminal Responses tail", async () => {
    const event = { type: "response.completed", response: { id: "resp_12345678", output: [], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } } };
    const { text, onStreamComplete } = await runStream(`event: response.completed\ndata: ${JSON.stringify(event)}`, {
      mode: "translate",
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    expect(text).toContain("event: response.completed\n");
    expect(text).not.toContain("response.failed");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.calls[0][1]).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });
});
