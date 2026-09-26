import { describe, expect, it } from "vitest";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function translate(model, fields = {}, source = FORMATS.OPENAI) {
  const messages = [{ role: "user", content: "Return the result" }];
  const body = source === FORMATS.OPENAI ? { messages } : { input: messages };
  return translateRequest(source, FORMATS.OPENAI_RESPONSES, model, { ...body, ...fields }, true, {}, "openai");
}

describe("GPT-6 Responses request translation", () => {
  it.each(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])("emits nested reasoning for %s", (model) => {
    const out = translate(model, { reasoning_effort: "high" });
    expect(out.reasoning.effort).toBe("high");
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out).not.toHaveProperty("messages");
    expect(out.input[0].content[0].text).toBe("Return the result");
  });

  it("preserves native reasoning effort and summary", () => {
    const out = translate("gpt-6-sol", { reasoning: { effort: "max", summary: "detailed" } }, FORMATS.OPENAI_RESPONSES);
    expect(out.reasoning).toEqual({ effort: "max", summary: "detailed" });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it.each([
    ["gpt-6-astra", "low"],
    ["gpt-6-sol", "none"],
    ["gpt-6-luna", "none"],
  ])("uses a supported effort when disabling reasoning on %s", (model, effort) => {
    const out = translate(model, { reasoning_effort: "none" });
    expect(out.reasoning.effort).toBe(effort);
  });

  it("preserves JSON schema constraints", () => {
    const json_schema = { name: "result", strict: true, schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
    const out = translate("gpt-6-sol", { response_format: { type: "json_schema", json_schema } });
    expect(out.text.format).toEqual({ type: "json_schema", ...json_schema });
    expect(out).not.toHaveProperty("response_format");
  });

  it("preserves forced tool selection and disabled parallel calls", () => {
    const out = translate("gpt-6-sol", {
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      parallel_tool_calls: false,
    });
    expect(out.tool_choice).toEqual({ type: "function", name: "lookup" });
    expect(out.parallel_tool_calls).toBe(false);
  });
});
