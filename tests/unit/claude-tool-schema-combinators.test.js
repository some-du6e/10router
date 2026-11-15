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

  // Parsed JSON is never cyclic; such an object is refused by the size walk, which
  // keeps only the description (no summary, so nothing walks the cycle).
  it("refuses a cyclic object up front, keeping only its description", () => {
    const cyclic = { description: "Loop", title: "Self", anyOf: [] };
    cyclic.anyOf.push(cyclic);
    expect(normalizeClaudeInputSchema(cyclic)).toEqual({
      type: "object", properties: {}, additionalProperties: true, description: "Loop",
    });
  });

  it("sets type object on a plain schema typed [object, null]", () => {
    expect(normalizeClaudeInputSchema({ type: ["object", "null"], properties: { a: { type: "string" } } }))
      .toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("lets a later allOf member win a property clash", () => {
    const out = normalizeClaudeInputSchema({ allOf: [{ properties: { a: { type: "string" } } }, { properties: { a: { type: "integer" } } }] });
    expect(out.properties).toEqual({ a: { type: "integer" } });
  });

  it("keeps a property named __proto__", () => {
    const out = normalizeClaudeInputSchema(JSON.parse(
      '{"anyOf":[{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"string"}}},{"type":"object","properties":{"b":{"type":"string"}}}]}',
    ));
    expect(Object.keys(out.properties)).toEqual(["__proto__", "a", "b"]);
    expect(Object.getPrototypeOf(out.properties)).toBe(Object.prototype);
    expect(JSON.stringify(out.properties)).toBe('{"__proto__":{"type":"string"},"a":{"type":"string"},"b":{"type":"string"}}');
  });

  // Definitions longer than MAX_KEY_LENGTH as JSON are told apart by identity only.
  it("compares long property definitions by identity, short ones by content", () => {
    const long = () => ({ type: "string", description: "d".repeat(300) });
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { big: long(), small: { type: "string" } } },
        { type: "object", properties: { big: long(), small: { type: "string" } } },
      ],
    });
    expect(out.properties.small).toEqual({ type: "string" });
    expect(out.properties.big).toEqual({ anyOf: [long(), long()] });
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

const PERMISSIVE = { type: "object", properties: {}, additionalProperties: true };
const isPermissive = (out) => {
  const { description, ...rest } = out;
  return JSON.stringify(rest) === JSON.stringify(PERMISSIVE) && (description === undefined || typeof description === "string");
};

const CAP_BYTES = 32 * 1024;
const CAP_NODES = 2000;
const countNodes = (value) => (value !== null && typeof value === "object"
  ? 1 + Object.values(value).reduce((n, child) => n + countNodes(child), 0) : 0);
const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const stringProps = (n, prefix) => Object.fromEntries(times(n, (j) => [`${prefix}${j}`, { type: "string" }]));
// "#/$defs/T" with the characters picked by `mask` percent-encoded.
const spell = (mask) => `#/${[..."$defs"].map((c, i) => (mask & (1 << i) ? `%${c.charCodeAt(0).toString(16)}` : c)).join("")}/${mask & 32 ? "%54" : "T"}`;

// Each shape, built as large as the input caps allow, with the result it must give.
const AT_CAP = {
  "$ref fan-out": {
    schema: () => fanOutSchema(165),
    check: (out) => expect(out).toEqual({ type: "object", description: "Fan out", properties: { leaf: { type: "string" } }, required: ["leaf"] }),
  },
  "members pointing at the next member twice": {
    schema: () => ({
      description: "Chain",
      anyOf: times(340, (k) => ({ type: "object", properties: { a: { $ref: `#/anyOf/${k + 1}` }, b: { $ref: `#/anyOf/${k + 1}` } } })),
    }),
    check: (out) => expect(out).toEqual({ ...PERMISSIVE, description: "Chain" }),
  },
  "a long pointer": {
    schema: () => ({ anyOf: [{ type: "object", title: "X", properties: { x: { type: "string" }, y: { $ref: `#/${"anyOf/0/".repeat(3500)}properties/x` } } }, byQuery] }),
    check: (out) => expect(out).toEqual({ ...PERMISSIVE, description: "Accepts one of: X; Search by free text." }),
  },
  "a wide anyOf": {
    schema: () => ({ anyOf: times(260, (i) => ({ type: "object", properties: stringProps(3, `p${i}_`) })) }),
    check: (out) => expect(Object.keys(out.properties)).toHaveLength(780),
  },
  "a wide allOf": {
    schema: () => ({ allOf: times(300, (i) => ({ properties: stringProps(3, `p${i}_`) })) }),
    check: (out) => expect(Object.keys(out.properties)).toHaveLength(900),
  },
  "wide required lists": {
    schema: () => ({ anyOf: times(20, () => ({ type: "object", required: times(200, (j) => `k${j}`) })) }),
    check: (out) => expect(out.required).toHaveLength(200),
  },
  "a $ref with siblings to a target with many keys": {
    schema: () => ({
      $defs: { T: { type: "object", ...Object.fromEntries(times(800, (j) => [`k${j}`, "v"])) } },
      anyOf: times(600, () => ({ $ref: "#/$defs/T", title: "m" })),
    }),
    check: (out) => expect(out).toEqual({ ...PERMISSIVE, description: "Accepts one of: m." }),
  },
  "one $ref spelled many ways": {
    schema: () => ({ $defs: { T: { type: "object", properties: { a: { type: "string" } } } }, anyOf: times(900, (i) => ({ $ref: spell(i % 64) })) }),
    check: (out) => expect(out).toEqual({ type: "object", properties: { a: { type: "string" } } }),
  },
  "a huge type array": {
    schema: () => ({ anyOf: [{ type: times(3000, () => "null") }, byQuery] }),
    check: (out) => expect(out.description).toBe("Accepts one of: a null, null, null, null, null, null, null, null; Search by free text."),
  },
  "a long description on an allOf target": {
    schema: () => ({ $defs: { T: { type: "object", description: "x".repeat(20_000), properties: { a: { type: "string" } } } }, allOf: times(400, () => ({ $ref: "#/$defs/T" })) }),
    check: (out) => {
      expect(out.properties).toEqual({ a: { type: "string" } });
      expect(out.description.length).toBeLessThanOrEqual(500);
    },
  },
  "a long description on an anyOf target": {
    schema: () => ({ $defs: { T: { type: "object", description: "x".repeat(20_000), properties: { a: { type: "string" } } } }, anyOf: times(400, () => ({ $ref: "#/$defs/T" })) }),
    check: (out) => expect(out).toEqual({ type: "object", properties: { a: { type: "string" } } }),
  },
};

describe("normalizeClaudeInputSchema at the input cap", () => {
  it.each(Object.keys(AT_CAP))("handles %s within the cap", (name) => {
    const { schema, check } = AT_CAP[name];
    const input = schema();
    const bytes = JSON.stringify(input).length;
    const nodes = countNodes(input);
    // Big enough to be near the cap, small enough to be flattened rather than refused.
    expect(bytes).toBeLessThanOrEqual(CAP_BYTES - 1024);
    expect(nodes).toBeLessThanOrEqual(CAP_NODES);
    expect(bytes > CAP_BYTES / 2 || nodes > CAP_NODES / 2).toBe(true);
    const start = performance.now();
    const out = normalizeClaudeInputSchema(input);
    const ms = performance.now() - start;
    console.log(`at cap: ${name}: ${bytes} B, ${nodes} nodes, ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
    expectPlainObjectSchema(out);
    expectLocalRefsResolve(out);
    check(out);
  });

  it("refuses input over the byte cap, keeping a truncated description", () => {
    const big = { description: "H".repeat(5000), anyOf: [{ type: "object", title: "Blob", properties: { blob: { type: "string", description: "x".repeat(70_000) } } }] };
    expect(normalizeClaudeInputSchema(big)).toEqual({ ...PERMISSIVE, description: `${"H".repeat(1023)}…` });
  });

  it("refuses input over the node cap while under the byte cap", () => {
    const wide = { description: "Many", anyOf: times(CAP_NODES + 2, () => ({})) };
    expect(JSON.stringify(wide).length).toBeLessThan(CAP_BYTES / 4);
    expect(normalizeClaudeInputSchema(wide)).toEqual({ ...PERMISSIVE, description: "Many" });
  });

  // One flatten of T fits the budget; 64 would not. So this flattens only if
  // the 64 spellings of the ref share one cache entry.
  it("flattens a costly $ref target once however the ref is spelled", () => {
    const T = { anyOf: times(50, (i) => ({ type: "object", title: `M${i}`, properties: stringProps(3, "p"), required: ["p0"] })) };
    const out = normalizeClaudeInputSchema({ $defs: { T }, anyOf: times(64, (i) => ({ $ref: spell(i) })) });
    expect(out).toEqual({ type: "object", properties: stringProps(3, "p"), required: ["p0"] });
  });

  // 400 members share one $ref target whose required entries are long arrays.
  // The schema flattens within the budget, so the alternatives get summarized
  // and the target is labelled for every member: cheap only if the label is
  // cached and doesn't stringify non-string entries.
  it("labels a shared $ref target cheaply when it's summarized, across 50 tools in one request", () => {
    const schema = () => ({ $defs: { T: { required: times(8, () => times(500, () => "a")) } }, anyOf: times(400, () => ({ $ref: "#/$defs/T" })) });
    expect(JSON.stringify(schema()).length).toBeLessThan(CAP_BYTES);
    const single = normalizeClaudeInputSchema(schema());
    expect(isPermissive(single)).toBe(false);
    expect(single.required).toHaveLength(8);
    const body = {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      tools: times(50, (i) => ({ type: "function", function: { name: `tool_${i}`, description: "d", parameters: schema() } })),
    };
    const start = performance.now();
    const out = translateRequest("openai", "claude", MODEL, body, false, { ...CREDS }, "claude");
    const ms = performance.now() - start;
    console.log(`50 tools with a costly shared label: ${ms.toFixed(1)} ms`);
    expect(out.tools).toHaveLength(50);
    for (const tool of out.tools) expectPlainObjectSchema(tool.input_schema);
    expect(ms).toBeLessThan(1500);
  });

  // Members point at ever deeper levels of one nested property; their
  // alternatives would repeat the levels below each one.
  // Nothing else in this shape can fail (no refs are left in the output, and
  // the work is tiny), and two levels of it flatten fine.
  it("falls back when flattening would more than double the schema", () => {
    const nested = (levels) => {
      let level = { type: "object", properties: stringProps(10, "f") };
      for (let d = 0; d < levels; d++) level = { type: "object", properties: { s: level, ...stringProps(10, "f") } };
      const path = (d) => `#/properties/s${"/properties/s".repeat(d)}`;
      return { description: "Nested", properties: { s: level }, anyOf: times(levels, (d) => ({ $ref: path(d) })) };
    };
    const small = normalizeClaudeInputSchema(nested(2));
    expect(Object.keys(small.properties)).toEqual(["s", ...Object.keys(stringProps(10, "f"))]);
    const deep = normalizeClaudeInputSchema(nested(20));
    expect(isPermissive(deep)).toBe(true);
    expect(deep.description).toMatch(/^Nested\n\nAccepts one of: #\/properties\/s; /);
  });

  it("flattens a top-level $ref to an object with 50 properties", () => {
    const properties = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field${i}`, { type: "object", properties: { v: { type: "string" } } }]));
    const out = normalizeClaudeInputSchema({ $ref: "#/definitions/Big", definitions: { Big: { type: "object", properties, required: ["field0"] } } });
    expect(out).toEqual({ type: "object", properties, required: ["field0"] });
  });

  it("flattens an anyOf with 125 enum properties and $defs", () => {
    const makeProps = () => Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`opt${i}`, { type: "string", enum: ["a", "b", "c", "d"] }]));
    const properties = makeProps();
    const out = normalizeClaudeInputSchema({
      $defs: { Shared: { type: "object", properties: makeProps(), required: ["opt0"] } },
      anyOf: [{ $ref: "#/$defs/Shared" }, { type: "object", properties: { ...makeProps(), extra: { $ref: "#/$defs/Shared" } }, required: ["opt0"] }],
    });
    expectPlainObjectSchema(out);
    expect(Object.keys(out.properties)).toHaveLength(126);
    expect(out.required).toEqual(["opt0"]);
    expect(out.$defs.Shared.properties).toEqual(properties);
    expectLocalRefsResolve(out);
  });
});

// Deterministic fuzz: random schemas with combinators, $defs and $refs (valid,
// into members, to members, dangling), checked for structural guarantees.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSchema(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const refs = ["#", "#/$defs/A", "#/$defs/B", "#/$defs/missing", "#/anyOf/0", "#/anyOf/1", "#/oneOf/0",
    "#/anyOf/0/properties/p0", "#/anyOf/1/properties/p1", "#/allOf/0/properties/p0", "#/oneOf/1/properties/p2",
    "#/properties/p0", "#/$defs/A/properties/p0", "#/anyOf/0/anyOf/1/properties/p1", "#/%E0", "other.json#/x"];
  const leaf = () => pick([{ type: "string" }, { type: "integer" }, { const: "x" }, { $ref: pick(refs) }, { type: "string", description: "d" }]);
  // Combinator members are mostly objects, so flattening (not only the fallback) gets exercised.
  const member = (depth) => node(depth, rand() < 0.85);
  const node = (depth, objectOnly = false) => {
    const r = objectOnly ? 0.5 : rand();
    if ((depth > 3 && !objectOnly) || r < 0.3) return leaf();
    if (r < 0.75) {
      const props = {};
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) props[`p${Math.floor(rand() * 4)}`] = node(depth + 1);
      const obj = { type: pick(["object", undefined, ["object", "null"]]), properties: props };
      if (rand() < 0.5) obj.required = Object.keys(props).filter(() => rand() < 0.6);
      if (rand() < 0.3) obj.title = pick(["T1", "T2", "T3"]);
      if (depth <= 3 && rand() < 0.2) obj[pick(["anyOf", "oneOf", "allOf"])] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => member(depth + 1));
      if (obj.type === undefined) delete obj.type;
      return obj;
    }
    return { [pick(["anyOf", "oneOf", "allOf"])]: Array.from({ length: Math.floor(rand() * 4) }, () => member(depth + 1)) };
  };
  const schema = { [pick(["anyOf", "oneOf", "allOf"])]: Array.from({ length: 1 + Math.floor(rand() * 4) }, () => member(1)) };
  if (rand() < 0.5) schema.$defs = { A: node(2), B: node(2) };
  if (rand() < 0.3) schema.properties = { p0: node(2) };
  if (rand() < 0.3) schema.description = "Top";
  if (rand() < 0.15) return { $ref: pick(["#/$defs/A", "#/$defs/B"]), $defs: schema.$defs || { A: schema, B: node(1) }, description: "Wrapped" };
  return schema;
}

// The seeded run gives 678 flattened (27 keeping local refs) and 1322 fallbacks;
// the floors leave room for small changes to the rules, not for losing an outcome.
const FUZZ_FLOOR = { flattened: 550, withRefs: 20, fallbacks: 1000 };

describe("normalizeClaudeInputSchema fuzz", () => {
  it("keeps its guarantees on 2000 seeded random schemas", () => {
    const rand = mulberry32(163);
    let fallbacks = 0;
    let withRefs = 0;
    const start = performance.now();
    for (let i = 0; i < 2000; i++) {
      const input = randomSchema(rand);
      const before = JSON.stringify(input);
      const out = normalizeClaudeInputSchema(input);
      expect(JSON.stringify(input), `case ${i} mutated its input`).toBe(before);
      const json = JSON.stringify(out);
      expectPlainObjectSchema(out);
      expectLocalRefsResolve(out);
      if (isPermissive(out)) fallbacks++;
      else {
        expect(json.length, `case ${i} grew`).toBeLessThanOrEqual(2 * before.length + 200);
        if (json.includes('"$ref":"#')) withRefs++;
      }
    }
    const ms = performance.now() - start;
    console.log(`fuzz: 2000 schemas, ${2000 - fallbacks} flattened (${withRefs} keeping local refs), ${fallbacks} fallbacks, ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(20_000);
    // Flattening, ref retargeting and the fallback are all exercised.
    expect(2000 - fallbacks).toBeGreaterThan(FUZZ_FLOOR.flattened);
    expect(withRefs).toBeGreaterThan(FUZZ_FLOOR.withRefs);
    expect(fallbacks).toBeGreaterThan(FUZZ_FLOOR.fallbacks);
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

  it("falls back on a ref to a property the alternatives define differently", () => {
    const out = normalizeClaudeInputSchema({
      oneOf: [
        { type: "object", title: "Text", properties: { value: { type: "string" } } },
        { type: "object", title: "Number", properties: { value: { type: "integer" }, copy: { $ref: "#/oneOf/0/properties/value" } } },
      ],
    });
    expect(out).toEqual({ ...PERMISSIVE, description: "Accepts one of: Text; Number." });
  });

  // Once "x" is a union of both members' x, "x/anyOf/0" isn't member 0's x/anyOf/0.
  it("falls back on a deep ref through a property that became a union", () => {
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", title: "A", properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] }, y: { $ref: "#/anyOf/0/properties/x/anyOf/0" } } },
        { type: "object", title: "B", properties: { x: { type: "integer" } } },
      ],
    });
    expect(out).toEqual({ ...PERMISSIVE, description: "Accepts one of: A; B." });
  });

  it("retargets a deep ref through a property both alternatives share", () => {
    const shared = () => ({ type: "object", properties: { street: { type: "string" } } });
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { address: shared(), copy: { $ref: "#/anyOf/0/properties/address/properties/street" } } },
        { type: "object", properties: { other: { type: "string" } } },
      ],
    });
    expect(out.properties.copy).toEqual({ $ref: "#/properties/address/properties/street" });
    expectLocalRefsResolve(out);
  });

  // The member's own Foo is a string; the root's Foo is an object. Retargeting
  // "#/anyOf/0/$defs/Foo" to "#/$defs/Foo" would silently change the type.
  it("falls back on a ref into a member's own $defs", () => {
    const out = normalizeClaudeInputSchema({
      $defs: { Foo: { type: "object", properties: { n: { type: "integer" } } } },
      anyOf: [
        { type: "object", title: "A", $defs: { Foo: { type: "string" } }, properties: { f: { $ref: "#/anyOf/0/$defs/Foo" } } },
        { type: "object", title: "B", properties: { g: { $ref: "#/$defs/Foo" } } },
      ],
    });
    expect(out).toEqual({ ...PERMISSIVE, description: "Accepts one of: A; B." });
  });

  it("falls back when a kept ref would now reach a property an alternative redefined", () => {
    const out = normalizeClaudeInputSchema({
      properties: { value: { type: "string" } },
      anyOf: [{ type: "object", title: "Int", properties: { value: { type: "integer" }, copy: { $ref: "#/properties/value" } } }, byId],
    });
    expect(out).toEqual({ ...PERMISSIVE, description: "Accepts one of: Int; By id." });
  });

  it("writes a retargeted ref as a URI fragment", () => {
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { "a%b": { type: "string" }, plain: { type: "integer" }, c: { $ref: "#/anyOf/0/properties/a%25b" }, d: { $ref: "#/anyOf/0/properties/plain" } } },
        byQuery,
      ],
    });
    expect(out.properties.c).toEqual({ $ref: "#/properties/a%25b" });
    expect(out.properties.d).toEqual({ $ref: "#/properties/plain" });
    const resolve = (ref) => ref.slice(2).split("/").map(decodeURIComponent).reduce((node, key) => node?.[key], out);
    expect(resolve(out.properties.c.$ref)).toEqual({ type: "string" });
    expect(resolve(out.properties.d.$ref)).toEqual({ type: "integer" });
  });

  it("keeps a definitions block a percent-encoded ref points into", () => {
    const out = normalizeClaudeInputSchema({
      $defs: { A: { type: "string" } },
      anyOf: [{ type: "object", properties: { x: { $ref: "#/%24defs/A" } } }, byQuery],
    });
    expect(out.$defs).toEqual({ A: { type: "string" } });
    expect(out.properties.x).toEqual({ $ref: "#/%24defs/A" });
  });

  it("leaves $ref-shaped data under const, enum and default alone", () => {
    const literal = () => ({ $ref: "#/anyOf/0/properties/target" });
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { target: { type: "string" }, a: { const: literal() }, b: { enum: [literal()] }, c: { type: "object", default: literal() } } },
        byQuery,
      ],
    });
    expect(out.properties.a).toEqual({ const: literal() });
    expect(out.properties.b).toEqual({ enum: [literal()] });
    expect(out.properties.c).toEqual({ type: "object", default: literal() });
  });

  it("leaves $ref-shaped data under examples and vendor x- keywords alone", () => {
    const literal = () => ({ $ref: "#/anyOf/0/properties/target" });
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { target: { type: "string" }, a: { type: "object", examples: [literal()] }, b: { type: "string", "x-source": literal() } } },
        byQuery,
      ],
    });
    expect(out.properties.a).toEqual({ type: "object", examples: [literal()] });
    expect(out.properties.b).toEqual({ type: "string", "x-source": literal() });
  });

  it("retargets a ref in a property named after a literal keyword", () => {
    const out = normalizeClaudeInputSchema({
      anyOf: [
        { type: "object", properties: { target: { type: "string" }, default: { $ref: "#/anyOf/0/properties/target" }, examples: { $ref: "#/anyOf/0/properties/target" } } },
        byQuery,
      ],
    });
    expect(out.properties.default).toEqual({ $ref: "#/properties/target" });
    expect(out.properties.examples).toEqual({ $ref: "#/properties/target" });
    expectLocalRefsResolve(out);
  });

  it.each([
    ["an empty $ref member (the document itself)", { anyOf: [{ $ref: "" }, byQuery] }],
    ["an empty $ref in a property", { anyOf: [{ type: "object", properties: { self: { $ref: "" } } }, byQuery] }],
    ["an empty top-level $ref", { $ref: "", anyOf: [byId, byQuery] }],
    ["a top-level $ref to the document", { $ref: "#", anyOf: [byId, byQuery] }],
    ["a ref resolved against $id", { $id: "https://example.com/root.json", anyOf: [{ type: "object", properties: { x: { $ref: "item.json" } } }, byQuery] }],
    ["a ref into another document", { anyOf: [{ type: "object", properties: { x: { $ref: "other.json#/x" } } }, byQuery] }],
  ])("falls back on %s", (_, schema) => {
    expect(isPermissive(normalizeClaudeInputSchema(schema))).toBe(true);
  });

  it("names non-string required entries by their type in a label", () => {
    expect(normalizeClaudeInputSchema({ anyOf: [{ type: "object", required: [1, ["k"]] }, { type: "string", title: "S" }] }))
      .toEqual({ ...PERMISSIVE, description: "Accepts one of: {number, object}; S." });
  });

  it("skips a blank-only title in a label", () => {
    expect(normalizeClaudeInputSchema({ anyOf: [{ type: "string", title: "   ", description: "Real" }, byQuery] }))
      .toEqual({ ...PERMISSIVE, description: "Accepts one of: Real; Search by free text." });
  });

  it("falls back on a member typed with an array that leaves out object", () => {
    expect(normalizeClaudeInputSchema({
      anyOf: [{ type: ["string", "integer"], title: "Scalar" }, { type: "object", title: "Obj", properties: { a: { type: "string" } } }],
    })).toEqual({ ...PERMISSIVE, description: "Accepts one of: Scalar; Obj." });
  });

  it("falls back on a ref that runs past a merged property into nothing", () => {
    expect(normalizeClaudeInputSchema({
      anyOf: [{ type: "object", title: "A", properties: { a: { type: "object" }, b: { $ref: "#/anyOf/0/properties/a/nowhere" } } }, byQuery],
    })).toEqual({ ...PERMISSIVE, description: "Accepts one of: A; Search by free text." });
  });

  // A slash inside a definition's name is escaped (~1), so "A/B" and A's B are different refs.
  it("doesn't confuse a definition named A/B with B inside A", () => {
    const out = normalizeClaudeInputSchema({
      $defs: { "A/B": { type: "object", properties: { x: { type: "string" } } }, A: { B: { type: "object", properties: { y: { type: "string" } } } } },
      anyOf: [{ $ref: "#/$defs/A~1B" }, { $ref: "#/$defs/A/B" }],
    });
    expect(out.properties).toEqual({ x: { type: "string" }, y: { type: "string" } });
  });

  it("keeps a definitions block that only another kept block points into", () => {
    const out = normalizeClaudeInputSchema({
      $defs: { A: { type: "object", properties: { b: { $ref: "#/definitions/B" } } } },
      definitions: { B: { type: "string" } },
      anyOf: [{ type: "object", properties: { a: { $ref: "#/$defs/A" } } }, byQuery],
    });
    expect(out.definitions).toEqual({ B: { type: "string" } });
    expect(out.$defs.A.properties.b).toEqual({ $ref: "#/definitions/B" });
    expectLocalRefsResolve(out);
  });

  // An unknown annotation keyword is walked like a schema position. That fails
  // safe: a ref there is only ever kept on the same object or retargeted to the
  // very same object, and anything else falls back.
  it("keeps the meaning of a $ref under an unknown annotation keyword", () => {
    const input = () => ({
      anyOf: [
        { type: "object", properties: { target: { type: "string", minLength: 2 }, a: { type: "string", metadata: { $ref: "#/anyOf/0/properties/target" } } } },
        byQuery,
      ],
    });
    const out = normalizeClaudeInputSchema(input());
    const ref = out.properties.a.metadata.$ref;
    const resolve = (r) => r.slice(2).split("/").map(decodeURIComponent).reduce((node, key) => node?.[key], out);
    expect(resolve(ref)).toEqual(input().anyOf[0].properties.target);
    const dangling = normalizeClaudeInputSchema({
      anyOf: [{ type: "object", title: "A", properties: { a: { type: "string", metadata: { $ref: "#/anyOf/0/properties/missing" } } } }, byQuery],
    });
    expect(dangling).toEqual({ ...PERMISSIVE, description: "Accepts one of: A; Search by free text." });
  });

  it("counts key length toward the byte cap", () => {
    const longKey = { description: "Keys", anyOf: [{ type: "object", properties: { ["k".repeat(CAP_BYTES)]: {} } }, byQuery] };
    expect(normalizeClaudeInputSchema(longKey)).toEqual({ ...PERMISSIVE, description: "Keys" });
  });

  it("puts a type into the label as written, $& included", () => {
    expect(normalizeClaudeInputSchema({ anyOf: [{ type: "$&x" }, byQuery] }))
      .toEqual({ ...PERMISSIVE, description: "Accepts one of: a $&x; Search by free text." });
  });

  it("merges a top-level $ref's sibling properties and required with the target's, the siblings winning", () => {
    const out = normalizeClaudeInputSchema({
      $ref: "#/$defs/A",
      properties: { extra: { type: "string" } },
      required: ["extra"],
      $defs: { A: { type: "object", properties: { a: { type: "string" }, extra: { type: "integer" } }, required: ["a"] } },
    });
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" }, extra: { type: "string" } }, required: ["a", "extra"] });
  });

  // zod's recursive union: a member's items point back at the member.
  it("falls back on a recursive member, with the summary", () => {
    const out = normalizeClaudeInputSchema({
      description: "Tree",
      anyOf: [
        { type: "object", title: "Dir", properties: { kind: { const: "dir" }, children: { type: "array", items: { $ref: "#/anyOf/0" } } } },
        { type: "object", title: "File", properties: { kind: { const: "file" } } },
      ],
    });
    expect(out).toEqual({ ...PERMISSIVE, description: "Tree\n\nAccepts one of: Dir; File." });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("falls back on a ref that pointed nowhere", () => {
    const out = normalizeClaudeInputSchema({
      description: "Lost",
      anyOf: [byId, { type: "object", properties: { lost: { $ref: "#/nowhere" } } }],
    });
    expect(out).toEqual({ ...PERMISSIVE, description: "Lost\n\nAccepts one of: By id; an object." });
  });

  it("merges sibling keys next to a $ref member, the siblings winning", () => {
    const out = normalizeClaudeInputSchema({
      $defs: { Base: { type: "object", properties: { id: { type: "string" }, kind: { type: "string" } }, required: ["id"] } },
      anyOf: [
        { $ref: "#/$defs/Base", title: "With note", properties: { note: { type: "string" }, kind: { const: "note" } }, required: ["note"] },
        { $ref: "#/$defs/Base", title: "Plain" },
      ],
    });
    expect(out.properties).toEqual({ id: { type: "string" }, kind: { anyOf: [{ const: "note" }, { type: "string" }] }, note: { type: "string" } });
    expect(out.required).toEqual(["id"]);
    expect(out.description).toBe("Accepts one of: With note; Plain.");
  });

  it("summarizes a top-level $ref target that can't be flattened", () => {
    const out = normalizeClaudeInputSchema({
      $ref: "#/definitions/Item",
      definitions: { Item: { description: "Thing", anyOf: [{ type: "string", title: "Text" }, byQuery] } },
    });
    expect(out).toEqual({ ...PERMISSIVE, description: "Thing\n\nAccepts one of: Text; Search by free text." });
  });

  it("pins the fallback for a schema that refers to itself", () => {
    expect(normalizeClaudeInputSchema({ description: "Self", anyOf: [{ $ref: "#" }] }))
      .toEqual({ ...PERMISSIVE, description: "Self\n\nAccepts one of: #." });
  });

  it("summarizes allOf in the fallback", () => {
    expect(normalizeClaudeInputSchema({ description: "Both", allOf: [{ type: "string", title: "Text" }, byId] }))
      .toEqual({ ...PERMISSIVE, description: "Both\n\nMust match all of: Text; By id." });
  });

  it("names at most six alternatives and truncates long names", () => {
    const long = "L".repeat(100);
    const members = [long, "T2", "T3", "T4", "T5", "T6", "T7", "T8"].map((title) => ({ type: "string", title }));
    const out = normalizeClaudeInputSchema({ anyOf: members });
    expect(out.description).toBe(`Accepts one of: ${"L".repeat(79)}…; T2; T3; T4; T5; T6; and 2 more.`);
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
