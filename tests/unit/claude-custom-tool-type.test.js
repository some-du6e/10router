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

  it("leaves a nameless tool alone", () => {
    const { body } = cloakClaudeTools({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "custom", input_schema: schema }, { name: "Read", input_schema: schema }],
    });

    expect(body.tools.map((t) => t.name)).not.toContain("undefined_ide");
  });
});
