// JSON Schema helpers shared by the tool translators.
import { JSON_SCHEMA_TYPE, JSON_SCHEMA_COMBINATOR, JSON_SCHEMA_REF } from "../schema/index.js";
import { dbg } from "../../utils/debugLog.js";

const { ALL_OF, ANY_OF, ONE_OF } = JSON_SCHEMA_COMBINATOR;
const OBJECT = JSON_SCHEMA_TYPE.OBJECT;
const COMBINATORS = [ALL_OF, ANY_OF, ONE_OF];
const ALTERNATIVES = [ANY_OF, ONE_OF];

// Bounds for nested combinators / $ref chains, and for the summary the model reads.
const MAX_DEPTH = 8;
const MAX_LISTED = 6;
const MAX_LABEL = 80;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const hasCombinator = (schema) => COMBINATORS.some((k) => has(schema, k));

// allOf semantics: the union of the members' properties (a later member wins a
// clash) and of their required keys, first-seen order. Non-object members are skipped.
export function mergeAllOfMembers(members) {
  const merged = {};
  for (const item of Array.isArray(members) ? members : []) {
    if (!isPlainObject(item)) continue;
    if (isPlainObject(item.properties)) {
      merged.properties = Object.assign(merged.properties || {}, item.properties);
    }
    if (Array.isArray(item.required)) {
      merged.required ??= [];
      for (const req of item.required) {
        if (!merged.required.includes(req)) merged.required.push(req);
      }
    }
  }
  return merged;
}

function permissiveSchema(description) {
  const schema = { type: OBJECT, properties: {}, additionalProperties: true };
  if (description) schema.description = description;
  return schema;
}

function truncate(text) {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

function label(member) {
  if (!isPlainObject(member)) return "a value";
  for (const text of [member.title, member.description]) {
    if (typeof text === "string" && text.trim()) return truncate(text.trim());
  }
  if (Array.isArray(member.required) && member.required.length) return `{${truncate(member.required.join(", "))}}`;
  if (typeof member[JSON_SCHEMA_REF] === "string") return truncate(member[JSON_SCHEMA_REF]);
  if (member.type !== undefined && member.type !== OBJECT) return `a ${truncate(String(member.type))}`;
  return "an object";
}

function summarize(prefix, members) {
  const listed = members.slice(0, MAX_LISTED).map(label);
  const more = members.length - listed.length;
  return `${prefix}: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}

const joinText = (...parts) => parts.filter((p) => typeof p === "string" && p.trim()).join("\n\n");

// Follow local "#/…" pointers against the root schema. null when unresolvable.
function resolveRef(schema, root) {
  let current = schema;
  for (let hops = 0; isPlainObject(current) && typeof current[JSON_SCHEMA_REF] === "string"; hops++) {
    const ref = current[JSON_SCHEMA_REF];
    if (hops >= MAX_DEPTH || !ref.startsWith("#/")) return null;
    let target = root;
    for (const raw of ref.slice(2).split("/")) {
      const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      target = isPlainObject(target) && has(target, key) ? target[key] : undefined;
    }
    if (!isPlainObject(target)) return null;
    const { [JSON_SCHEMA_REF]: _ref, ...siblings } = current;
    current = { ...target, ...siblings };
  }
  return current;
}

// Every alternative's properties. A name the alternatives define differently
// keeps each definition as a property-level anyOf, which is allowed nested.
function alternativeProperties(members) {
  const defs = new Map();
  for (const member of members) {
    if (!isPlainObject(member.properties)) continue;
    for (const [name, def] of Object.entries(member.properties)) {
      const list = defs.get(name) || [];
      if (!list.some((seen) => JSON.stringify(seen) === JSON.stringify(def))) list.push(def);
      defs.set(name, list);
    }
  }
  const properties = {};
  for (const [name, list] of defs) properties[name] = list.length === 1 ? list[0] : { [ANY_OF]: list };
  return properties;
}

// One object schema equivalent enough to `schema` with no top-level combinator,
// or null when a member isn't an object schema we can flatten.
function flatten(schema, root, depth) {
  if (depth > MAX_DEPTH) return null;
  const resolved = resolveRef(schema, root);
  if (!isPlainObject(resolved) || (resolved.type !== undefined && resolved.type !== OBJECT)) return null;
  if (!hasCombinator(resolved)) return resolved;

  const base = { ...resolved };
  for (const key of COMBINATORS) delete base[key];
  const parts = [base];
  const notes = [];

  const flattenAll = (members) => {
    if (!Array.isArray(members) || members.length === 0) return null;
    const out = [];
    for (const member of members) {
      const flat = flatten(member, root, depth + 1);
      if (!flat) return null;
      out.push(flat);
    }
    return out;
  };

  if (has(resolved, ALL_OF)) {
    const members = flattenAll(resolved[ALL_OF]);
    if (!members) return null;
    parts.push(...members);
    notes.push(...members.map((m) => m.description));
  }

  // anyOf / oneOf: any member's properties may be sent; only keys every member
  // requires stay required. The alternatives go into the description instead.
  for (const key of ALTERNATIVES) {
    if (!has(resolved, key)) continue;
    const members = flattenAll(resolved[key]);
    if (!members) return null;
    const requiredBy = members.map((m) => (Array.isArray(m.required) ? m.required : []));
    const required = requiredBy.reduce((acc, keys) => acc.filter((k) => keys.includes(k)));
    parts.push({ properties: alternativeProperties(members), required });
    notes.push(summarize("Accepts one of", members));
  }

  const merged = mergeAllOfMembers(parts);
  const out = { ...base, type: OBJECT, properties: merged.properties || {} };
  if (merged.required?.length) out.required = merged.required;
  else delete out.required;
  const description = joinText(base.description, ...notes);
  if (description) out.description = description;
  return out;
}

// Description for the permissive fallback: the original intent, in words.
function fallbackDescription(schema) {
  const notes = [];
  if (Array.isArray(schema[ALL_OF])) notes.push(summarize("Must match all of", schema[ALL_OF]));
  for (const key of ALTERNATIVES) {
    if (Array.isArray(schema[key])) notes.push(summarize("Accepts one of", schema[key]));
  }
  return joinText(schema.description, ...notes);
}

// A Claude tool's input_schema must be a plain object schema at the top level:
// Anthropic-style Messages APIs reject allOf/anyOf/oneOf there (nested inside
// properties they're fine, and left alone). Returns the schema itself when
// nothing needs changing, otherwise a new schema; never mutates or throws.
export function normalizeClaudeInputSchema(schema) {
  try {
    if (!isPlainObject(schema)) return permissiveSchema();
    if (!hasCombinator(schema)) {
      return schema.type === undefined && isPlainObject(schema.properties) ? { ...schema, type: OBJECT } : schema;
    }
    const copy = structuredClone(schema);
    return flatten(copy, copy, 0) || permissiveSchema(fallbackDescription(copy));
  } catch {
    return permissiveSchema();
  }
}

// The tool with a normalized input_schema; the tool itself when unchanged or schemaless.
export function normalizeClaudeToolSchema(tool) {
  if (!isPlainObject(tool) || tool.input_schema === undefined) return tool;
  const inputSchema = normalizeClaudeInputSchema(tool.input_schema);
  return inputSchema === tool.input_schema ? tool : { ...tool, input_schema: inputSchema };
}

// Same array back when no tool changed, so untouched requests stay byte-identical.
export function normalizeClaudeToolSchemas(tools) {
  if (!Array.isArray(tools)) return tools;
  const out = tools.map(normalizeClaudeToolSchema);
  const changed = out.filter((tool, i) => tool !== tools[i]).length;
  if (!changed) return tools;
  dbg("TOOLSCHEMA", `normalized input_schema of ${changed} tool(s)`);
  return out;
}
