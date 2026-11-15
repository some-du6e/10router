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
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";
import { buildProviderRequest } from "../../open-sse/executors/zed.js";

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

  it("resolves a local $ref member and drops the $defs nothing points at any more", () => {
    const out = normalizeClaudeInputSchema({
      $defs: { byId },
      anyOf: [{ $ref: "#/$defs/byId" }, byQuery],
    });
    expectPlainObjectSchema(out);
    expect(out.properties).toHaveProperty("id");
    expect(out.properties).toHaveProperty("query");
    expect(out).not.toHaveProperty("$defs");
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
    expect(out.description).toBe("Accepts one of: By id; Search by free text.");
  });

  it("keeps every alternative's definition of a property they define differently", () => {
    const out = normalizeClaudeInputSchema({
      oneOf: [
        { type: "object", properties: { value: { type: "string" }, unit: { type: "string" } } },
        { type: "object", properties: { value: { type: "integer" }, unit: { type: "string" } } },
      ],
    });
    expect(out.properties).toEqual({
      value: { anyOf: [{ type: "string" }, { type: "integer" }] },
      unit: { type: "string" },
    });
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

  // The summary only comes from the depth-bound fallback; the catch-all keeps the
  // bare description. So these pin the bound itself, not a caught stack overflow.
  it("stops at the depth bound and keeps the top-level description", () => {
    let schema = { type: "object", properties: { leaf: { type: "string" } } };
    for (let i = 0; i < 40; i++) schema = { title: "Level", anyOf: [schema] };
    schema.description = "Deep";
    expect(normalizeClaudeInputSchema(schema)).toEqual({
      type: "object", properties: {}, additionalProperties: true, description: "Deep\n\nAccepts one of: Level.",
    });
  });

  it("stops at the depth bound on a cyclic object", () => {
    const cyclic = { description: "Loop", title: "Self", anyOf: [] };
    cyclic.anyOf.push(cyclic);
    expect(normalizeClaudeInputSchema(cyclic)).toEqual({
      type: "object", properties: {}, additionalProperties: true, description: "Loop\n\nAccepts one of: Self.",
    });
  });

  it("treats a malformed % in a $ref as unresolvable and keeps the description", () => {
    const out = normalizeClaudeInputSchema({ description: "Pick", anyOf: [{ $ref: "#/$defs/%E0%A4%A" }, byQuery] });
    expect(out).toEqual({
      type: "object", properties: {}, additionalProperties: true,
      description: "Pick\n\nAccepts one of: #/$defs/%E0%A4%A; Search by free text.",
    });
  });

  it("gives an empty anyOf no summary", () => {
    expect(normalizeClaudeInputSchema({ description: "Empty", anyOf: [] }).description).toBe("Empty");
  });

  it("skips a summary that only says 'an object'", () => {
    const out = normalizeClaudeInputSchema({
      anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "string" } } }],
    });
    expect(out).not.toHaveProperty("description");
  });

  it("flattens a combinator next to type [object, null]", () => {
    const out = normalizeClaudeInputSchema({ type: ["object", "null"], anyOf: [byId, byQuery] });
    expectPlainObjectSchema(out);
    expect(Object.keys(out.properties)).toEqual(["id", "verbose", "query"]);
  });
});

// D0..D6 each an anyOf of N refs to the next, D7 a plain object, and a top-level
// anyOf of N refs to D0: N^8 paths through 1.6 KB of JSON.
function fanOutSchema(n) {
  const $defs = { D7: { type: "object", properties: { leaf: { type: "string" } }, required: ["leaf"] } };
  for (let k = 0; k < 7; k++) $defs[`D${k}`] = { anyOf: Array.from({ length: n }, () => ({ $ref: `#/$defs/D${k + 1}` })) };
  return { description: "Fan out", $defs, anyOf: Array.from({ length: n }, () => ({ $ref: "#/$defs/D0" })) };
}

// Every local $ref in `schema` points at something in `schema`.
function expectLocalRefsResolve(schema) {
  const resolve = (ref) => {
    if (ref === "#") return schema;
    return ref.slice(2).split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((node, key) => (node !== null && typeof node === "object" && Object.hasOwn(node, key) ? node[key] : undefined), schema);
  };
  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#")) {
      expect(resolve(node.$ref), `dangling ${node.$ref}`).toBeDefined();
    }
    Object.values(node).forEach(walk);
  };
  walk(schema);
}

describe("normalizeClaudeInputSchema work bound", () => {
  it("flattens an exponential $ref fan-out in well under 50ms", () => {
    const schema = fanOutSchema(8);
    expect(JSON.stringify(schema).length).toBeLessThan(2000);
    const start = performance.now();
    const out = normalizeClaudeInputSchema(schema);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expectPlainObjectSchema(out);
    expect(out.properties).toEqual({ leaf: { type: "string" } });
    expect(out.required).toEqual(["leaf"]);
    expect(out.description).toBe("Fan out");
    expectLocalRefsResolve(out);
  });

  it("falls back, keeping the description, once the step budget runs out", () => {
    const members = Array.from({ length: 600 }, (_, i) => ({ type: "object", properties: { [`p${i}`]: { type: "string" } } }));
    const out = normalizeClaudeInputSchema({ description: "Too wide", anyOf: members });
    expect(out).toEqual({ type: "object", properties: {}, additionalProperties: true, description: "Too wide" });
  });
});

describe("normalizeClaudeInputSchema $refs", () => {
  it("points a ref into a removed anyOf member at the merged property", () => {
    const address = { type: "object", properties: { street: { type: "string" } } };
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { address } },
        { type: "object", properties: { billing: { $ref: "#/anyOf/0/properties/address" } } },
      ],
    });
    expect(out.properties.billing).toEqual({ $ref: "#/properties/address" });
    expect(out.properties.address).toEqual(address);
    expectLocalRefsResolve(out);
  });

  it("points a ref into a removed allOf member at the merged property", () => {
    const out = normalizeClaudeInputSchema({
      allOf: [
        { properties: { a: { type: "string", minLength: 2 } } },
        { properties: { b: { $ref: "#/allOf/0/properties/a" } } },
      ],
    });
    expect(out.properties.b).toEqual({ $ref: "#/properties/a" });
    expectLocalRefsResolve(out);
  });

  it("inlines the target when the merged property is a different schema", () => {
    const out = normalizeClaudeInputSchema({
      oneOf: [
        { type: "object", properties: { value: { type: "string" } } },
        { type: "object", properties: { value: { type: "integer" }, copy: { $ref: "#/oneOf/0/properties/value", description: "Copy" } } },
      ],
    });
    expect(out.properties.value).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
    expect(out.properties.copy).toEqual({ type: "string", description: "Copy" });
    expectLocalRefsResolve(out);
  });

  it("inlines a ref to a whole removed member, and its own refs", () => {
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { tag: { type: "string" }, inner: { $ref: "#/anyOf/0/properties/tag" } } },
        { type: "object", properties: { other: { $ref: "#/anyOf/0" } } },
      ],
    });
    expect(out.properties.other.properties.inner).toEqual({ $ref: "#/properties/tag" });
    expectLocalRefsResolve(out);
  });

  it("drops a ref that pointed nowhere", () => {
    const out = normalizeClaudeInputSchema({
      anyOf: [byId, { type: "object", properties: { lost: { $ref: "#/nowhere", description: "Lost" } } }],
    });
    expect(out.properties.lost).toEqual({ description: "Lost" });
    expectLocalRefsResolve(out);
  });

  it("resolves a top-level $ref and drops a definitions block nothing uses", () => {
    const out = normalizeClaudeInputSchema({ $ref: "#/definitions/Item", definitions: { Item: { anyOf: [byId, byQuery] } } });
    expectPlainObjectSchema(out);
    expect(out).not.toHaveProperty("$ref");
    expect(out).not.toHaveProperty("definitions");
    expect(Object.keys(out.properties)).toEqual(["id", "verbose", "query"]);
    expect(out.required).toEqual(["verbose"]);
  });

  it("keeps the definitions block a top-level $ref's inner refs need", () => {
    const tag = { type: "string", enum: ["a", "b"] };
    const out = normalizeClaudeInputSchema({
      $ref: "#/definitions/Item",
      definitions: {
        Tag: tag,
        Item: { oneOf: [{ ...byId, properties: { ...byId.properties, tag: { $ref: "#/definitions/Tag" } } }, byQuery] },
      },
    });
    expectPlainObjectSchema(out);
    expect(out.properties.tag).toEqual({ $ref: "#/definitions/Tag" });
    expect(out.definitions.Tag).toEqual(tag);
    expectLocalRefsResolve(out);
  });

  it("gives a top-level $ref to a plain object type object", () => {
    const out = normalizeClaudeInputSchema({ $ref: "#/$defs/A", $defs: { A: { properties: { q: { type: "string" } } } } });
    expect(out).toEqual({ type: "object", properties: { q: { type: "string" } } });
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

const toolAddition = (input_schema) => ({
  role: "system",
  content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "tool_d", description: "Added later", input_schema } } }],
});
const findAddition = (body) => body.messages
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .find((b) => b.type === "tool_addition");

describe("claude → claude on a Claude-format provider outside the native pairs", () => {
  it("flattens a tool added by value mid-conversation", () => {
    const body = routes.claude(SEARCH_SCHEMA);
    body.messages.push(
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      toolAddition({ description: "Find later", oneOf: [byId, byQuery] }),
      { role: "user", content: "next" },
    );
    const out = translateRequest("claude", "claude", MODEL, body, false, { ...CREDS }, "glm");

    expect(out.tools.map((t) => t.name)).toEqual(NAMES);
    for (const tool of out.tools) expectPlainObjectSchema(tool.input_schema);
    const schema = findAddition(out).tool.definition.input_schema;
    expectPlainObjectSchema(schema);
    expect(schema.required).toEqual(["verbose"]);
    expect(schema.description).toBe("Find later\n\nAccepts one of: By id; Search by free text.");
  });
});

describe("Zed route to Anthropic", () => {
  it("sends flattened tool schemas, in order", () => {
    const out = buildProviderRequest("Anthropic", MODEL, routes.openai(SEARCH_SCHEMA), true, null);
    expect(out.tools.map((t) => t.name)).toEqual(NAMES);
    for (const tool of out.tools) expectPlainObjectSchema(tool.input_schema);
    expect(JSON.stringify(out.tools[0].input_schema)).toBe(JSON.stringify(TOOL_A_SCHEMA));
  });
});

describe("cleanJSONSchemaForAntigravity allOf (shared merge)", () => {
  it("merges allOf next to sibling properties, inside properties too, skipping null members", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        base: { type: "string" },
        nested: { type: "object", allOf: [{ properties: { x: { type: "integer" } }, required: ["x"] }] },
      },
      required: ["base"],
      allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, null],
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        base: { type: "string" },
        nested: { type: "object", properties: { x: { type: "integer" } }, required: ["x"] },
        a: { type: "string" },
      },
      required: ["base", "a"],
    });
  });
});
