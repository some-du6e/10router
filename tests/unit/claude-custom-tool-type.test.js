import { describe, it, expect } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";

const schema = { type: "object", properties: { cmd: { type: "string" } } };

describe("prepareClaudeRequest keeps explicit custom tools", () => {
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

  it("drops OpenAI-style custom tools that lack a name or input_schema", () => {
    const out = prepareClaudeRequest({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "custom", custom: { name: "apply_patch", format: { type: "text" } } },
        { type: "custom", name: "freeform", format: { type: "text" } },
        { name: "plain", description: "p", input_schema: schema },
      ],
    }, "anthropic-compatible-abc");

    expect(out.tools.map((t) => t.name)).toEqual(["plain"]);
  });
});

describe("cloakClaudeTools renames custom tools", () => {
  it("suffixes a type:custom tool instead of treating it as a built-in", () => {
    const { body, toolNameMap } = cloakClaudeTools({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "custom", name: "Bash", input_schema: schema }],
    });
    const names = body.tools.map((t) => t.name);

    expect(names).toContain("Bash_ide");
    expect(new Set(names).size).toBe(names.length);
    expect(toolNameMap.get("Bash_ide")).toBe("Bash");
  });

  it.each([61, 62, 64])("keeps a %i-character tool name within 64 once suffixed, and maps it back", (length) => {
    const name = `t${"x".repeat(length - 1)}`;
    const other = `t${"x".repeat(length - 2)}y`;
    const { body, toolNameMap } = cloakClaudeTools({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input: {} }] },
      ],
      tools: [{ type: "custom", name, input_schema: schema }, { name: other, input_schema: schema }],
      tool_choice: { type: "tool", name },
    });
    const [cloaked, cloakedOther] = body.tools.map((t) => t.name);

    expect(cloaked.length).toBeLessThanOrEqual(64);
    expect(cloaked.endsWith("_ide")).toBe(true);
    expect(cloaked).not.toBe(cloakedOther);
    expect(toolNameMap.get(cloaked)).toBe(name);
    expect(toolNameMap.get(cloakedOther)).toBe(other);
    // History and the forced choice use the same cloaked name as the declaration.
    expect(body.messages[1].content[0].name).toBe(cloaked);
    expect(body.tool_choice.name).toBe(cloaked);
  });

  it("leaves a short tool name as name + suffix", () => {
    const { body } = cloakClaudeTools({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "x".repeat(60), input_schema: schema }] });

    expect(body.tools[0].name).toBe(`${"x".repeat(60)}_ide`);
  });

  it("leaves a nameless tool alone", () => {
    const { body } = cloakClaudeTools({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "custom", input_schema: schema }, { name: "Read", input_schema: schema }],
    });

    expect(body.tools.map((t) => t.name)).not.toContain("undefined_ide");
  });
});
