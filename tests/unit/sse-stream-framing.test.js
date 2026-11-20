import { describe, expect, it, vi, onTestFinished } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

const encoder = new TextEncoder();

async function runStream(input, options = {}) {
  const onStreamComplete = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
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

// Write each part separately, advancing the clock after each one, so a stream
// that is billed as cut short gets a visible time floor.
async function runParts(parts, options = {}, { clock = null, stepMs = 0 } = {}) {
  const onStreamComplete = vi.fn();
  const ts = createSSEStream({ provider: "openai", ...options, onStreamComplete });
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const drain = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })();
  for (const part of parts) {
    await writer.write(encoder.encode(part));
    clock?.advance(stepMs);
  }
  await writer.close().catch(() => {});
  await drain;
  return { text, onStreamComplete };
}

function fakeClock() {
  let now = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => spy.mockRestore());
  return { advance: (ms) => { now += ms; } };
}

function spyFlushErrors() {
  const spy = vi.spyOn(console, "log");
  onTestFinished(() => spy.mockRestore());
  return () => spy.mock.calls.filter(([first]) => first === "Error in flush:");
}

const dataObjects = (text) => text
  .split("\n")
  .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
  .map((l) => JSON.parse(l.slice(6)));

const withoutCreated = ({ created, ...rest }) => rest;

const claudeEvent = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}`;
const chatData = (choice, extra = {}) => `data: ${JSON.stringify({ id: "chatcmpl-abc12345", model: "m", choices: [{ index: 0, ...choice }], ...extra })}`;
const body = { model: "m", messages: [{ role: "user", content: "hi" }] };

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
      { aborted: false },
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

describe("passthrough terminal sentinel framing", () => {
  const line = `data: ${JSON.stringify({ id: "chatcmpl-abc12345", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: { content: "hi" } }] })}`;

  it("closes a content tail without a newline before the fallback sentinel", async () => {
    const { text } = await runStream(line);
    expect(text).toBe(`${line}\n\ndata: [DONE]\n\n`);
  });

  it("closes the previous frame when the upstream sends [DONE] with no blank line before it", async () => {
    const { text } = await runStream(`${line}\ndata: [DONE]\n\n`);
    expect(text).toBe(`${line}\n\ndata: [DONE]\n\n`);
  });

  it("ignores data the upstream sends after its [DONE]", async () => {
    const { text, onStreamComplete } = await runStream(`data: [DONE]\n\n${line}\n\n`);
    expect(text).toBe("data: [DONE]\n\n");
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });
});

describe("Gemini-family passthrough", () => {
  const line = `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] })}`;

  it.each(["gemini", "vertex", "antigravity"])("closes an open %s tail frame with a blank line and adds no [DONE]", async (provider) => {
    const { text } = await runStream(line, { provider });
    expect(text).toBe(`${line}\n\n`);
  });

  it("adds nothing after a frame the upstream already closed", async () => {
    const { text } = await runStream(`${line}\n\n`, { provider: "gemini" });
    expect(text).toBe(`${line}\n\n`);
  });
});

describe("a Chat Completions upstream whose [DONE] has no trailing newline", () => {
  const content = `${chatData({ delta: { role: "assistant", content: "hi" } })}\n\n`;
  // The [DONE] is the EOF tail, so flush() sends the final events: the stream
  // must not be terminated from inside flush().
  function spyTerminate() {
    const spy = vi.spyOn(TransformStreamDefaultController.prototype, "terminate");
    onTestFinished(() => spy.mockRestore());
    return spy;
  }

  it("finishes a Claude client once, without a flush error", async () => {
    const flushErrors = spyFlushErrors();
    const terminate = spyTerminate();
    const { text } = await runParts([content, "data: [DONE]"], {
      mode: "translate", targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.CLAUDE, body,
    });
    expect(text.match(/event: message_stop/g)).toHaveLength(1);
    expect(text.match(/event: message_delta/g)).toHaveLength(1);
    expect(dataObjects(text).find((e) => e.type === "message_delta").delta.stop_reason).toBe("end_turn");
    expect(flushErrors()).toEqual([]);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("completes a Responses client once, without a flush error", async () => {
    const flushErrors = spyFlushErrors();
    const terminate = spyTerminate();
    const finish = `${chatData({ delta: {}, finish_reason: "stop" })}\n\n`;
    const { text } = await runParts([content, finish, "data: [DONE]"], {
      mode: "translate", targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI_RESPONSES, body,
    });
    expect(text.match(/event: response\.completed/g)).toHaveLength(1);
    expect(text).not.toContain("response.failed");
    expect(flushErrors()).toEqual([]);
    expect(terminate).not.toHaveBeenCalled();
  });
});

describe("the [DONE] sentinel on translated streams", () => {
  const frames = (text) => text.split("\n\n").filter(Boolean);
  const doneCount = (text) => (text.match(/data: \[DONE\]/g) || []).length;
  // The upstream's events as one body; "" leaves the last event as the EOF tail.
  const join = (events, ending) => events.map((e, i) => (i === events.length - 1 ? `${e}${ending}` : `${e}\n\n`)).join("");
  const translate = (events, ending, formats) => runStream(join(events, ending), { mode: "translate", body, ...formats });

  const claudeReply = [
    claudeEvent({ type: "message_start", message: { id: "msg_abcdefgh", model: "claude-x", usage: { input_tokens: 25, output_tokens: 1 } } }),
    claudeEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }),
    claudeEvent({ type: "content_block_stop", index: 0 }),
    claudeEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    claudeEvent({ type: "message_stop" }),
  ];
  const chatReply = [
    chatData({ delta: { role: "assistant", content: "hello" } }),
    chatData({ delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 25, completion_tokens: 9, total_tokens: 34 } }),
    "data: [DONE]",
  ];
  const responsesEvent = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}`;
  const responsesDelta = responsesEvent({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hello" });
  const responsesCompleted = responsesEvent({ type: "response.completed", response: { id: "resp_12345678", output: [], usage: { input_tokens: 25, output_tokens: 9, total_tokens: 34 } } });

  // The frame before [DONE] is the finish chunk, so the sentinel comes after the final usage.
  const expectOneDoneAfterFinish = (text) => {
    expect(doneCount(text)).toBe(1);
    const all = frames(text);
    expect(all.at(-1)).toBe("data: [DONE]");
    expect(JSON.parse(all.at(-2).slice(6)).choices[0].finish_reason).toBe("stop");
  };

  it.each(["\n\n", ""])("ends a Claude upstream to an OpenAI chat client with one [DONE] after the finish chunk and its usage (ending %j)", async (ending) => {
    const { text, onStreamComplete } = await translate(claudeReply, ending, { targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI });
    expectOneDoneAfterFinish(text);
    expect(JSON.parse(frames(text).at(-2).slice(6)).usage).toEqual(expect.objectContaining({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) }));
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a Chat Completions upstream", FORMATS.OPENAI, chatReply],
    ["a Responses upstream", FORMATS.OPENAI_RESPONSES, [responsesDelta, responsesCompleted, "data: [DONE]"]],
    // No response.completed: the finish chunk only comes out of flush(), and the sentinel follows it.
    ["a Responses upstream that never completes", FORMATS.OPENAI_RESPONSES, [responsesDelta, "data: [DONE]"]],
  ])("sends an OpenAI chat client one [DONE] when %s sends its own", async (_name, targetFormat, events) => {
    for (const ending of ["\n\n", ""]) {
      const { text } = await translate(events, ending, { targetFormat, sourceFormat: FORMATS.OPENAI });
      expectOneDoneAfterFinish(text);
    }
  });

  // A chat stream that never sent its finish chunk must not look finished:
  // an error frame, then the one [DONE], and no finish_reason anywhere.
  const expectErrorThenDone = (text) => {
    expect(doneCount(text)).toBe(1);
    const all = frames(text);
    expect(all.at(-1)).toBe("data: [DONE]");
    expect(JSON.parse(all.at(-2).slice(6)).error).toEqual(expect.objectContaining({ message: expect.any(String) }));
    expect(dataObjects(text).some((c) => c.choices?.[0]?.finish_reason)).toBe(false);
  };
  const claudeToolStart = claudeEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_abcdefgh", name: "lookup", input: {} } });

  it("ends a Claude upstream that errors mid tool call with an error frame and one [DONE]", async () => {
    const events = [
      claudeReply[0],
      claudeToolStart,
      claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"q\":" } }),
      claudeEvent({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    ];
    const { text } = await translate(events, "\n\n", { targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI });
    expect(text).toContain("tool_calls");
    expectErrorThenDone(text);
  });

  it("ends a Responses upstream that closes with no response.completed and no [DONE] with an error frame and one [DONE]", async () => {
    const { text } = await translate([responsesDelta], "\n\n", { targetFormat: FORMATS.OPENAI_RESPONSES, sourceFormat: FORMATS.OPENAI });
    expect(text).toContain("\"content\":\"hello\"");
    expectErrorThenDone(text);
  });

  it("ends the stream with an error frame and one [DONE] when flush() throws", async () => {
    const flushErrors = spyFlushErrors();
    // The tool_use start is the EOF tail, so it is translated inside flush(), where the lookup throws.
    const toolNameMap = { size: 1, get: () => { throw new Error("tool map broke"); } };
    const { text } = await runStream(join([claudeReply[0], claudeToolStart], ""), {
      mode: "translate", body, toolNameMap, targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI,
    });
    expect(flushErrors()).toHaveLength(1);
    expectErrorThenDone(text);
  });

  it("fails a Responses-to-Responses stream before its [DONE] when flush() throws", async () => {
    const flushErrors = spyFlushErrors();
    // The delta is the EOF tail, so it is sent from flush(), where logging it throws once.
    let thrown = false;
    const reqLogger = {
      appendConvertedChunk: (chunk) => {
        if (!thrown && chunk.includes("response.output_text.delta")) { thrown = true; throw new Error("log broke"); }
      },
    };
    const { text } = await runStream(join([responsesDelta], ""), {
      mode: "translate", body, reqLogger, targetFormat: FORMATS.OPENAI_RESPONSES, sourceFormat: FORMATS.OPENAI_RESPONSES,
    });
    expect(flushErrors()).toHaveLength(1);
    expect(doneCount(text)).toBe(1);
    const all = frames(text);
    expect(all.at(-1)).toBe("data: [DONE]");
    expect(all.at(-2)).toMatch(/^event: response\.failed\n/);
    expect(text).not.toContain("event: response.completed");
  });

  it.each([
    ["a Claude client", "a Claude upstream", FORMATS.CLAUDE, FORMATS.CLAUDE, claudeReply],
    ["a Claude client", "a Chat Completions upstream", FORMATS.CLAUDE, FORMATS.OPENAI, chatReply],
    ["a Responses client", "a Claude upstream", FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, claudeReply],
    ["a Responses client", "a Chat Completions upstream", FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, chatReply],
  ])("adds no [DONE] for %s on %s", async (_client, _upstream, sourceFormat, targetFormat, events) => {
    for (const ending of ["\n\n", ""]) {
      const { text } = await translate(events, ending, { targetFormat, sourceFormat });
      expect(doneCount(text)).toBe(0);
      const all = frames(text);
      if (sourceFormat === FORMATS.CLAUDE) expect(all.at(-1)).toMatch(/^event: message_stop\n/);
      else expect(all.some((f) => /^event: response\.completed\n/.test(f))).toBe(true);
    }
  });

  it.each([
    ["with", [responsesDelta, responsesCompleted, "data: [DONE]"]],
    ["without", [responsesDelta, responsesCompleted]],
  ])("keeps one [DONE] after response.completed for Responses to Responses %s an upstream [DONE]", async (_name, events) => {
    const { text } = await translate(events, "\n\n", { targetFormat: FORMATS.OPENAI_RESPONSES, sourceFormat: FORMATS.OPENAI_RESPONSES });
    expect(doneCount(text)).toBe(1);
    const all = frames(text);
    expect(all.at(-1)).toBe("data: [DONE]");
    expect(all.at(-2)).toMatch(/^event: response\.completed\n/);
    expect(text).not.toContain("response.failed");
  });
});

describe("a translated final chunk without a trailing newline", () => {
  // 20 s between chunks: if the tail's final usage were missed, the stream
  // would be billed as cut short at 150 output tokens per second.
  const run = (parts, formats) => runParts(parts, { mode: "translate", body, ...formats }, { clock: fakeClock(), stepMs: 20_000 });

  it("Claude upstream to an OpenAI client: records the exact usage and the same finish chunk", async () => {
    const parts = [
      `${claudeEvent({ type: "message_start", message: { id: "msg_abcdefgh", model: "claude-x", usage: { input_tokens: 25, output_tokens: 1 } } })}\n\n`,
      `${claudeEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `${claudeEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}\n\n`,
      claudeEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    ];
    const formats = { targetFormat: FORMATS.CLAUDE, sourceFormat: FORMATS.OPENAI };
    const tail = await run(parts, formats);
    const terminated = await run([...parts.slice(0, -1), `${parts.at(-1)}\n\n`], formats);

    const usage = tail.onStreamComplete.mock.calls[0][1];
    expect(usage).toMatchObject({ prompt_tokens: 25, completion_tokens: 9 });
    expect(usage).not.toHaveProperty("estimated");
    expect(tail.onStreamComplete.mock.calls[0][3]).toEqual({ aborted: false });

    const finishOf = (text) => dataObjects(text).find((c) => c.choices?.[0]?.finish_reason);
    expect(finishOf(tail.text).choices[0].finish_reason).toBe("stop");
    expect(withoutCreated(finishOf(tail.text))).toEqual(withoutCreated(finishOf(terminated.text)));
  });

  it("Chat Completions upstream to a Claude client: records the exact usage and the same message_delta", async () => {
    const parts = [
      `${chatData({ delta: { role: "assistant", content: "hello" } })}\n\n`,
      chatData({ delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 25, completion_tokens: 9, total_tokens: 34 } }),
    ];
    const formats = { targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.CLAUDE };
    const tail = await run(parts, formats);
    const terminated = await run([parts[0], `${parts[1]}\n\n`], formats);

    const usage = tail.onStreamComplete.mock.calls[0][1];
    expect(usage).toMatchObject({ input_tokens: 25, output_tokens: 9 });
    expect(usage).not.toHaveProperty("estimated");
    expect(tail.onStreamComplete.mock.calls[0][3]).toEqual({ aborted: false });

    const deltaOf = (text) => dataObjects(text).find((e) => e.type === "message_delta");
    expect(deltaOf(tail.text).delta.stop_reason).toBe("end_turn");
    expect(deltaOf(tail.text)).toEqual(deltaOf(terminated.text));
    expect(tail.text.match(/event: message_stop/g)).toHaveLength(1);
  });
});
