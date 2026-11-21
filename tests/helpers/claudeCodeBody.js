// A Claude Code shaped /v1/messages request: system blocks, tool schemas, and a
// history of thinking + tool_use turns answered by large tool results.

export function lorem(n, seed) {
  const words = ["const", "function", "return", "await", "import", "export", "value", "result", "error", "stream", "request", "provider", "model", "token", "buffer", "handler"];
  let out = "";
  let x = seed * 2654435761 >>> 0;
  while (out.length < n) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += words[x % words.length] + ((x >> 8) % 9 === 0 ? ";\n" : " ");
  }
  return out.slice(0, n);
}

function toolSchema(i) {
  const props = {};
  for (let p = 0; p < 6; p++) {
    props[`param_${p}`] = { type: p % 2 ? "string" : "number", description: lorem(120, i * 10 + p) };
  }
  props.options = { type: "object", properties: { mode: { type: "string", enum: ["a", "b", "c"] }, deep: { type: "array", items: { type: "string" } } } };
  return { name: `Tool${i}`, description: lorem(900, i), input_schema: { type: "object", properties: props, required: ["param_0"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" } };
}

export function claudeCodeBody(model, { messages = 50, tools = 17, toolResultChars = 13000 } = {}) {
  const msgs = [{ role: "user", content: [{ type: "text", text: "<system-reminder>" + lorem(4000, 1) + "</system-reminder>" }, { type: "text", text: "Fix the bug in the stream handler." }] }];
  for (let i = 1; msgs.length < messages - 1; i++) {
    const id = `toolu_01${String(i).padStart(22, "0")}`;
    msgs.push({ role: "assistant", content: [
      { type: "thinking", thinking: lorem(600, i + 100), signature: "Eq" + "A".repeat(400) },
      { type: "text", text: lorem(200, i + 200) },
      { type: "tool_use", id, name: `Tool${i % tools}`, input: { param_0: i, param_1: lorem(80, i), options: { mode: "a" } } },
    ] });
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: lorem(toolResultChars, i + 300) }] }] });
  }
  msgs.push({ role: "user", content: [{ type: "text", text: "Now run the tests.", cache_control: { type: "ephemeral" } }] });
  return {
    model,
    max_tokens: 32000,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 31999 },
    metadata: { user_id: "user_bench_account__session_00000000-0000-0000-0000-000000000000" },
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: lorem(12000, 7), cache_control: { type: "ephemeral" } },
    ],
    tools: Array.from({ length: tools }, (_, i) => toolSchema(i)),
    messages: msgs,
  };
}
