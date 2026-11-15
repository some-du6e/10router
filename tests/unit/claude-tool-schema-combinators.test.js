// Anthropic-style Messages APIs reject a tool whose input_schema has
// allOf/anyOf/oneOf at the top level (nested inside properties is fine). One
// such tool used to fail the whole turn on every key; the router now flattens
// the schema for every request that ends in Claude format.
import { describe, it, expect } from "vitest";
import {
  normalizeClaudeInputSchema,
  normalizeClaudeToolSchemas,
  mergeAllOfMembers,
} from "../../open-sse/translator/concerns/jsonSchema.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";

const MODEL = "claude-test-model";
const CREDS = { apiKey: "test-key" };
const COMBINATORS = ["allOf", "anyOf", "oneOf"];

const byId = {
  title: "By id",
  type: "object",
  properties: { id: { type: "string" }, verbose: { type: "boolean" } },
  required: ["id", "verbose"],
};
const byQuery = {
  type: "object",
  description: "Search by free text",
  properties: { query: { type: "string" }, verbose: { type: "boolean" } },
  required: ["query", "verbose"],
};

const expectPlainObjectSchema = (schema) => {
  expect(schema.type).toBe("object");
  for (const key of COMBINATORS) expect(schema).not.toHaveProperty(key);
};

describe("normalizeClaudeInputSchema", () => {
  it("merges a top-level allOf into one object schema", () => {
    const out = normalizeClaudeInputSchema({
      description: "Create an item",
      allOf: [
        { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        { properties: { tags: { type: "array", items: { type: "string" } } }, required: ["tags", "name"] },
      ],
    });
    expect(out).toEqual({
      type: "object",
      description: "Create an item",
      properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      required: ["name", "tags"],
    });
  });

  it.each(["anyOf", "oneOf"])("flattens a top-level %s of objects", (key) => {
    const out = normalizeClaudeInputSchema({ description: "Look up items", [key]: [byId, byQuery] });
    expectPlainObjectSchema(out);
    expect(out.properties).toEqual({ id: { type: "string" }, verbose: { type: "boolean" }, query: { type: "string" } });
    expect(out.required).toEqual(["verbose"]);
    expect(out.description).toBe("Look up items\n\nAccepts one of: By id; Search by free text.");
  });

  it("drops required when no key is required by every member, and labels members by required keys", () => {
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ],
    });
    expect(out).not.toHaveProperty("required");
    expect(out.description).toBe("Accepts one of: {a}; {b}.");
  });

  it("keeps base properties next to the combinator", () => {
    const out = normalizeClaudeInputSchema({
      type: "object",
      properties: { limit: { type: "integer" } },
      required: ["limit"],
      oneOf: [byId, byQuery],
    });
    expect(Object.keys(out.properties)).toEqual(["limit", "id", "verbose", "query"]);
    expect(out.required).toEqual(["limit", "verbose"]);
  });

  it("resolves a local $ref member", () => {
    const out = normalizeClaudeInputSchema({
      $defs: { byId },
      anyOf: [{ $ref: "#/$defs/byId" }, byQuery],
    });
    expectPlainObjectSchema(out);
    expect(out.properties).toHaveProperty("id");
    expect(out.properties).toHaveProperty("query");
    expect(out.$defs).toEqual({ byId });
  });

  it("falls back to a permissive object schema when a member isn't an object", () => {
    const out = normalizeClaudeInputSchema({
      description: "Item key",
      anyOf: [{ type: "string", description: "A bare id" }, byQuery],
    });
    expect(out).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
      description: "Item key\n\nAccepts one of: A bare id; Search by free text.",
    });
  });

  it("falls back when a $ref can't be resolved", () => {
    const out = normalizeClaudeInputSchema({ oneOf: [{ $ref: "#/$defs/missing" }, { $ref: "https://example.com/s.json" }] });
    expect(out).toMatchObject({ type: "object", properties: {}, additionalProperties: true });
    expect(out.description).toBe("Accepts one of: #/$defs/missing; https://example.com/s.json.");
  });

  it("sets type object when it's missing but properties exist", () => {
    const schema = { properties: { q: { type: "string" } } };
    expect(normalizeClaudeInputSchema(schema)).toEqual({ type: "object", properties: { q: { type: "string" } } });
  });

  it("leaves nested combinators untouched and returns the same schema", () => {
    const schema = {
      type: "object",
      properties: {
        target: { anyOf: [{ type: "string" }, { type: "integer" }] },
        mode: { oneOf: [{ const: "a" }, { const: "b" }] },
        opts: { allOf: [{ type: "object" }] },
      },
    };
    expect(normalizeClaudeInputSchema(schema)).toBe(schema);
  });

  it("flattens nested top-level combinators inside members and keeps member property combinators", () => {
    const out = normalizeClaudeInputSchema({
      allOf: [
        { anyOf: [byId, byQuery] },
        { type: "object", properties: { target: { oneOf: [{ type: "string" }, { type: "integer" }] } } },
      ],
    });
    expectPlainObjectSchema(out);
    expect(out.properties.target).toEqual({ oneOf: [{ type: "string" }, { type: "integer" }] });
    expect(out.required).toEqual(["verbose"]);
  });

  it("does not mutate its input", () => {
    const input = { description: "d", $defs: { byId }, anyOf: [{ $ref: "#/$defs/byId" }, byQuery], allOf: [{ properties: { x: {} } }] };
    const snapshot = structuredClone(input);
    const out = normalizeClaudeInputSchema(input);
    expect(input).toEqual(snapshot);
    out.properties.id.type = "changed";
    expect(input).toEqual(snapshot);
  });

  it.each([
    ["null", null],
    ["a string", "not a schema"],
    ["an array", [1, 2]],
    ["a non-array anyOf", { anyOf: "nope" }],
    ["an empty oneOf", { oneOf: [] }],
    ["null members", { allOf: [null, undefined] }],
    ["a self-referencing $ref", { $defs: { a: { $ref: "#/$defs/a" } }, anyOf: [{ $ref: "#/$defs/a" }] }],
    ["deep nesting", JSON.parse(`${'{"anyOf":['.repeat(40)}{}${"]}".repeat(40)}`)],
  ])("never throws on %s and returns an object schema", (_, input) => {
    let out;
    expect(() => { out = normalizeClaudeInputSchema(input); }).not.toThrow();
    expectPlainObjectSchema(out);
  });

  it("fails open on a cyclic object", () => {
    const cyclic = { anyOf: [] };
    cyclic.anyOf.push(cyclic);
    expect(normalizeClaudeInputSchema(cyclic)).toMatchObject({ type: "object", properties: {}, additionalProperties: true });
  });
});

describe("mergeAllOfMembers", () => {
  it("unions properties and required, skipping non-object members", () => {
    expect(mergeAllOfMembers([{ properties: { a: {} }, required: ["a"] }, null, "x", { properties: { b: {} }, required: ["a", "b"] }]))
      .toEqual({ properties: { a: {}, b: {} }, required: ["a", "b"] });
    expect(mergeAllOfMembers(undefined)).toEqual({});
  });
});

describe("normalizeClaudeToolSchemas", () => {
  it("returns the same array when nothing changes and leaves schemaless tools alone", () => {
    const tools = [{ type: "web_search_20250305", name: "web_search" }, { name: "tool_a", input_schema: { type: "object" } }];
    expect(normalizeClaudeToolSchemas(tools)).toBe(tools);
    expect(normalizeClaudeToolSchemas(undefined)).toBeUndefined();
  });

  it("copies only the tool it changes", () => {
    const plain = { name: "tool_a", input_schema: { type: "object" } };
    const combinator = { name: "search_items", input_schema: { anyOf: [byId, byQuery] } };
    const out = normalizeClaudeToolSchemas([plain, combinator]);
    expect(out[0]).toBe(plain);
    expect(out[1]).not.toBe(combinator);
    expect(combinator.input_schema).toHaveProperty("anyOf");
    expectPlainObjectSchema(out[1].input_schema);
  });
});

// ── End to end through translateRequest ──────────────────────────────────────

const TOOL_A_SCHEMA = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const TOOL_C_SCHEMA = {
  type: "object",
  properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
  additionalProperties: false,
};
const SEARCH_SCHEMA = { description: "Find items", anyOf: [byId, byQuery] };
const PLAIN_SEARCH_SCHEMA = { type: "object", properties: {} };
const NAMES = ["tool_a", "search_items", "tool_c"];

const toolDefs = (searchSchema) => [
  { name: "tool_a", description: "Read a file", schema: TOOL_A_SCHEMA },
  { name: "search_items", description: "Search the catalogue", schema: searchSchema },
  { name: "tool_c", description: "Set a value", schema: TOOL_C_SCHEMA },
].map((t) => ({ ...t, schema: structuredClone(t.schema) }));

const routes = {
  "openai-responses": (schema) => ({
    model: MODEL,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: toolDefs(schema).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.schema })),
  }),
  openai: (schema) => ({
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    tools: toolDefs(schema).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
  }),
  claude: (schema) => ({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    tools: toolDefs(schema).map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
  }),
};

describe.each(Object.keys(routes))("%s → claude", (source) => {
  const translate = (schema) => translateRequest(source, "claude", MODEL, routes[source](schema), false, { ...CREDS }, "claude");

  it("sends every tool with a plain object input_schema, in order", () => {
    const out = translate(SEARCH_SCHEMA);
    expect(out.tools.map((t) => t.name)).toEqual(NAMES);
    for (const tool of out.tools) expectPlainObjectSchema(tool.input_schema);
    expect(out.tools[1].input_schema.required).toEqual(["verbose"]);
    expect(out.tools[1].input_schema.description).toContain("Accepts one of: By id; Search by free text.");
  });

  it("leaves the other tools byte-identical", () => {
    const out = translate(SEARCH_SCHEMA);
    const control = translate(PLAIN_SEARCH_SCHEMA);
    expect(JSON.stringify(out.tools[0])).toBe(JSON.stringify(control.tools[0]));
    expect(JSON.stringify(out.tools[2])).toBe(JSON.stringify(control.tools[2]));
    expect(JSON.stringify(out.tools[0].input_schema)).toBe(JSON.stringify(TOOL_A_SCHEMA));
    expect(JSON.stringify(out.tools[2].input_schema)).toBe(JSON.stringify(TOOL_C_SCHEMA));
  });

  it("does not touch the client's tool schemas", () => {
    const body = routes[source](SEARCH_SCHEMA);
    const clientTools = body.tools;
    const before = JSON.stringify(clientTools);
    translateRequest(source, "claude", MODEL, body, false, { ...CREDS }, "claude");
    expect(JSON.stringify(clientTools)).toBe(before);
  });
});

describe("claude passthrough", () => {
  it("flattens tools[] and tools added by value mid-conversation", () => {
    const body = routes.claude(SEARCH_SCHEMA);
    const original = structuredClone(body.tools);
    body.messages.push(
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "system",
        content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "tool_d", input_schema: { oneOf: [byId, byQuery] } } } }],
      },
      { role: "user", content: "next" },
    );
    const sent = { ...body };
    normalizeClaudePassthrough(sent, MODEL, "claude");

    expect(sent.tools.map((t) => t.name)).toEqual(NAMES);
    for (const tool of sent.tools) expectPlainObjectSchema(tool.input_schema);
    expect(sent.tools[0]).toBe(body.tools[0]);
    expect(sent.tools[2]).toBe(body.tools[2]);
    expect(body.tools).toEqual(original);

    const addition = sent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_addition");
    expectPlainObjectSchema(addition.tool.definition.input_schema);
  });
});
