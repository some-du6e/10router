import { describe, it, expect } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";

const schema = { type: "object", properties: { cmd: { type: "string" } } };

describe("prepareClaudeRequest keeps explicit custom tools", () => {
  // chatCore stamps `type: "custom"` on every Claude tool, so a request that
  // comes back through here (combo, retry, Claude Code to a compatible
  // endpoint) arrives with it already set. Dropping it left Codex sessions
  // with no tools at all: the model replied "I don't have an exec_command tool".
  it("keeps a type:custom tool for an anthropic-compatible provider", () => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "custom", name: "exec_command", description: "run", input_schema: schema }],
    }, "anthropic-compatible-abc");

    expect(out.tools?.map((t) => t.name)).toEqual(["exec_command"]);
  });

  it("still strips built-in server tools for non-Anthropic providers", () => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { name: "plain", description: "p", input_schema: schema },
      ],
    }, "anthropic-compatible-abc");

    expect(out.tools.map((t) => t.name)).toEqual(["plain"]);
  });
});
