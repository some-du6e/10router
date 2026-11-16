// Prints the Claude body the router builds for a Responses request whose tool
// schema starts with anyOf. The claude-tool-schema workflow runs this file on
// the base branch and on the PR to show the body before and after the fix, so
// it imports only the public translator entry, which exists on both.
import { it, expect } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";

it("prints the Claude tools built for a top-level anyOf tool schema", () => {
  const body = {
    model: "claude-test-model",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [{
      type: "function",
      name: "search_items",
      description: "Search the catalogue",
      parameters: {
        description: "Find items",
        anyOf: [
          { title: "By id", type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          { title: "By query", type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        ],
      },
    }],
  };
  const out = translateRequest("openai-responses", "claude", body.model, body, false, { apiKey: "test-key" }, "claude");
  const tool = out.tools.find((t) => t.name === "search_items");
  console.log(`CLAUDE_TOOL_SCHEMA_BODY ${JSON.stringify({ tools: [{ name: tool.name, input_schema: tool.input_schema }] })}`);
  expect(tool).toBeDefined();
});
