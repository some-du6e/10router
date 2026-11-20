import { describe, expect, it } from "vitest";

import { transformToOllama } from "../../open-sse/utils/ollamaTransform.js";

const chunk = (choice) => `data: ${JSON.stringify({ id: "chatcmpl-abc12345", choices: [{ index: 0, ...choice }] })}\n\n`;

async function toOllama(sse) {
  const res = transformToOllama(new Response(sse, { headers: { "content-type": "text/event-stream" } }), "m");
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("transformToOllama", () => {
  it.each(["", "data: [DONE]\n\n"])("ends a finished answer with one done:true (upstream tail %j)", async (tail) => {
    const lines = await toOllama(chunk({ delta: { content: "hello" } }) + chunk({ delta: {}, finish_reason: "stop" }) + tail);
    expect(lines.filter((l) => l.done)).toHaveLength(1);
    expect(lines.at(-1).done).toBe(true);
    expect(lines.map((l) => l.message.content).join("")).toBe("hello");
  });

  it("puts the tool calls on the one done:true line", async () => {
    const lines = await toOllama(
      chunk({ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\":1}" } }] } })
      + chunk({ delta: {}, finish_reason: "tool_calls" })
      + "data: [DONE]\n\n",
    );
    const done = lines.filter((l) => l.done);
    expect(done).toHaveLength(1);
    expect(done[0].message.tool_calls).toEqual([{ function: { name: "lookup", arguments: { q: 1 } } }]);
  });

  it("still ends a stream with no finish chunk and no [DONE]", async () => {
    const lines = await toOllama(chunk({ delta: { content: "hello" } }));
    expect(lines.filter((l) => l.done)).toHaveLength(1);
    expect(lines.at(-1).done).toBe(true);
  });
});
