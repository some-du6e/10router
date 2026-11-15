// JSON Schema helpers shared by the tool translators.
import { JSON_SCHEMA_TYPE, JSON_SCHEMA_COMBINATOR, JSON_SCHEMA_REF, JSON_SCHEMA_DEFS } from "../schema/index.js";
import { CLAUDE_TOOL_SCHEMA_LIMITS, CLAUDE_TOOL_SCHEMA_TEXT as TEXT } from "../../config/claudeToolSchema.js";
import { dbg } from "../../utils/debugLog.js";

const { ALL_OF, ANY_OF, ONE_OF } = JSON_SCHEMA_COMBINATOR;
const { MAX_DEPTH, MAX_STEPS, MAX_LISTED, MAX_LABEL } = CLAUDE_TOOL_SCHEMA_LIMITS;
const OBJECT = JSON_SCHEMA_TYPE.OBJECT;
const REF = JSON_SCHEMA_REF;
const COMBINATORS = [ALL_OF, ANY_OF, ONE_OF];
const ALTERNATIVES = [ANY_OF, ONE_OF];
const DEFS_KEYS = Object.values(JSON_SCHEMA_DEFS);
const GENERIC_LABELS = new Set([TEXT.OBJECT, TEXT.VALUE]);
const IN_PROGRESS = Symbol("in progress");

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const hasCombinator = (schema) => COMBINATORS.some((k) => has(schema, k));
const isObjectType = (type) => type === undefined || type === OBJECT || (Array.isArray(type) && type.includes(OBJECT));
const isLocalRef = (node) => isPlainObject(node) && typeof node[REF] === "string" && node[REF].startsWith("#");
const sameJSON = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

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

// ── Descriptions ────────────────────────────────────────────────────────────

function truncate(text) {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

function label(member) {
  if (!isPlainObject(member)) return TEXT.VALUE;
  for (const text of [member.title, member.description]) {
    if (typeof text === "string" && text.trim()) return truncate(text.trim());
  }
  if (Array.isArray(member.required) && member.required.length) return `{${truncate(member.required.join(", "))}}`;
  if (typeof member[REF] === "string") return truncate(member[REF]);
  if (member.type !== undefined && member.type !== OBJECT) return TEXT.TYPED.replace("{type}", truncate(String(member.type)));
  return TEXT.OBJECT;
}

// "Accepts one of: A; B." Empty when the members give nothing to tell apart:
// no members, only generic labels, or fewer distinct ones than `minDistinct`.
function summarize(prefix, members, minDistinct = 1) {
  if (!Array.isArray(members) || !members.length) return "";
  const labels = [...new Set(members.map(label))];
  if (labels.length < minDistinct || labels.every((l) => GENERIC_LABELS.has(l))) return "";
  const listed = labels.slice(0, MAX_LISTED);
  const more = labels.length - listed.length;
  if (more > 0) listed.push(TEXT.MORE.replace("{n}", String(more)));
  return `${prefix}: ${listed.join("; ")}.`;
}

const joinText = (...parts) => [...new Set(parts.filter((p) => typeof p === "string" && p.trim()))].join("\n\n");

// The original intent, in words, for the permissive fallback.
function fallbackDescription(schema) {
  if (!isPlainObject(schema)) return "";
  const notes = [summarize(TEXT.ALL_OF, schema[ALL_OF])];
  for (const key of ALTERNATIVES) notes.push(summarize(TEXT.ONE_OF, schema[key]));
  return joinText(schema.description, ...notes);
}

// ── JSON pointers ───────────────────────────────────────────────────────────

// "#/a/b~1c" → ["a", "b/c"]; null when not a local pointer or malformed.
function parsePointer(ref) {
  if (typeof ref !== "string" || !ref.startsWith("#")) return null;
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return null;
  try {
    return ref.slice(2).split("/").map((raw) => decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"));
  } catch {
    return null;
  }
}

const formatPointer = (keys) => (keys.length ? `#/${keys.map((k) => k.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}` : "#");

function resolvePointer(root, ref) {
  const keys = parsePointer(ref);
  if (!keys) return undefined;
  let target = root;
  for (const key of keys) {
    if (Array.isArray(target) && /^\d+$/.test(key) && Number(key) < target.length) target = target[Number(key)];
    else if (isPlainObject(target) && has(target, key)) target = target[key];
    else return undefined;
  }
  return target;
}

// "#/anyOf/0/allOf/1/properties/a" → "#/properties/a": where a property of a
// flattened member ends up. null when the ref doesn't start inside a combinator.
function mergedLocation(ref) {
  let keys = parsePointer(ref);
  if (!keys) return null;
  let stripped = false;
  while (keys.length >= 2 && COMBINATORS.includes(keys[0]) && /^\d+$/.test(keys[1])) {
    keys = keys.slice(2);
    stripped = true;
  }
  return stripped ? formatPointer(keys) : null;
}

// ── Flattening ──────────────────────────────────────────────────────────────

// One pass over one tool schema. Every node visited costs a step, so the work
// is bounded however the schema nests or fans out its $refs.
function createContext(root) {
  return { root, steps: 0, exhausted: false, memo: new Map() };
}

function step(ctx) {
  if (++ctx.steps > MAX_STEPS) ctx.exhausted = true;
  return !ctx.exhausted;
}

// Every alternative's properties. A name the alternatives define differently
// keeps each definition as a property-level anyOf, which is allowed nested.
function alternativeProperties(members) {
  const defs = new Map();
  for (const member of members) {
    if (!isPlainObject(member.properties)) continue;
    for (const [name, def] of Object.entries(member.properties)) {
      const list = defs.get(name) || [];
      if (!list.some((seen) => sameJSON(seen, def))) list.push(def);
      defs.set(name, list);
    }
  }
  const properties = {};
  for (const [name, list] of defs) properties[name] = list.length === 1 ? list[0] : { [ANY_OF]: list };
  return properties;
}

// A $ref member: its target is flattened once per ref and reused, so a schema
// that points at the same definition many times costs one flatten, not one per path.
function flattenRef(schema, ctx, depth) {
  const { [REF]: ref, ...siblings } = schema;
  let target = ctx.memo.get(ref);
  if (target === IN_PROGRESS) return null;
  if (target === undefined) {
    ctx.memo.set(ref, IN_PROGRESS);
    const resolved = resolvePointer(ctx.root, ref);
    // Same depth: the member holding the ref already counted this level.
    target = isPlainObject(resolved) ? flatten(resolved, ctx, depth) : null;
    ctx.memo.set(ref, target);
  }
  if (!target || !Object.keys(siblings).length) return target;
  const rest = flatten(siblings, ctx, depth + 1);
  if (!rest) return null;
  const merged = mergeAllOfMembers([target, rest]);
  const out = { ...target, ...rest };
  if (merged.properties) out.properties = merged.properties;
  if (merged.required) out.required = merged.required;
  return out;
}

// One object schema equivalent enough to `schema` with no top-level combinator,
// or null when a member isn't an object schema we can flatten (or the budget ran out).
function flatten(schema, ctx, depth) {
  if (!step(ctx) || depth > MAX_DEPTH || !isPlainObject(schema)) return null;
  if (typeof schema[REF] === "string") return flattenRef(schema, ctx, depth);
  if (!isObjectType(schema.type)) return null;
  if (!hasCombinator(schema)) return schema;

  const base = { ...schema };
  for (const key of COMBINATORS) delete base[key];
  const parts = [base];
  const notes = [];

  const flattenAll = (members) => {
    if (!Array.isArray(members) || members.length === 0) return null;
    const out = [];
    for (const member of members) {
      const flat = flatten(member, ctx, depth + 1);
      if (!flat) return null;
      out.push(flat);
    }
    return out;
  };

  if (has(schema, ALL_OF)) {
    const members = flattenAll(schema[ALL_OF]);
    if (!members) return null;
    parts.push(...members);
    notes.push(...members.map((m) => m.description));
  }

  // anyOf / oneOf: any member's properties may be sent; only keys every member
  // requires stay required. The alternatives go into the description instead.
  for (const key of ALTERNATIVES) {
    if (!has(schema, key)) continue;
    const members = flattenAll(schema[key]);
    if (!members) return null;
    const requiredBy = members.map((m) => (Array.isArray(m.required) ? m.required : []));
    const required = requiredBy.reduce((acc, keys) => acc.filter((k) => keys.includes(k)));
    parts.push({ properties: alternativeProperties(members), required });
    // Alternatives that flatten to the same thing aren't a choice worth describing.
    notes.push(summarize(TEXT.ONE_OF, members, 2));
  }

  const merged = mergeAllOfMembers(parts);
  const out = { ...base, type: OBJECT, properties: merged.properties || {} };
  if (merged.required?.length) out.required = merged.required;
  else delete out.required;
  const description = joinText(base.description, ...notes);
  if (description) out.description = description;
  else delete out.description;
  return out;
}

// A top-level $ref, followed to the schema it names. The root's other keys
// (its definitions block, a description) stay next to it.
function resolveTop(root, ctx) {
  let top = root;
  for (let hops = 0; typeof top[REF] === "string"; hops++) {
    if (hops >= MAX_DEPTH || !step(ctx)) return null;
    const target = resolvePointer(root, top[REF]);
    if (!isPlainObject(target)) return null;
    const { [REF]: _ref, ...siblings } = top;
    top = { ...target, ...siblings };
  }
  return top;
}

// Refs into the removed combinator arrays ("#/anyOf/0/properties/a", which
// zod-to-json-schema writes) are pointed at the merged property when it's the
// same schema, and otherwise replaced by the schema they pointed at. A ref that
// pointed nowhere to begin with becomes an unconstrained schema.
function repairRefs(out, ctx) {
  const seen = new Set();
  const repair = (node) => {
    const { [REF]: ref, ...siblings } = node;
    const original = resolvePointer(ctx.root, ref);
    const merged = mergedLocation(ref);
    if (merged && original !== undefined && sameJSON(resolvePointer(out, merged), original)) {
      return { ...node, [REF]: merged };
    }
    return isPlainObject(original) ? { ...original, ...siblings } : siblings;
  };
  const visit = (node, inlined) => {
    if (ctx.exhausted || node === null || typeof node !== "object" || seen.has(node) || !step(ctx)) return node;
    if (isLocalRef(node) && resolvePointer(out, node[REF]) === undefined) {
      if (inlined >= MAX_DEPTH) {
        ctx.exhausted = true;
        return node;
      }
      return visit(repair(node), inlined + 1);
    }
    seen.add(node);
    for (const key of Object.keys(node)) node[key] = visit(node[key], 0);
    return node;
  };
  return visit(out, 0);
}

// Local refs found in `node`, without descending into `skip`.
function collectRefs(node, skip, ctx, refs = [], seen = new Set()) {
  if (ctx.exhausted || node === null || typeof node !== "object" || node === skip || seen.has(node) || !step(ctx)) return refs;
  seen.add(node);
  if (isLocalRef(node)) refs.push(node[REF]);
  for (const child of Object.values(node)) collectRefs(child, skip, ctx, refs, seen);
  return refs;
}

// A definitions block nothing points into any more is dropped.
function dropUnusedDefs(out, ctx) {
  for (const key of DEFS_KEYS) {
    if (!isPlainObject(out[key])) continue;
    const prefix = formatPointer([key]);
    const used = collectRefs(out, out[key], ctx).some((ref) => ref === prefix || ref.startsWith(`${prefix}/`));
    if (!used && !ctx.exhausted) delete out[key];
  }
  return out;
}

// A Claude tool's input_schema must be a plain object schema at the top level:
// Anthropic-style Messages APIs reject allOf/anyOf/oneOf there (nested inside
// properties they're fine, and left alone). Returns the schema itself when
// nothing needs changing, otherwise a new schema; never mutates or throws.
export function normalizeClaudeInputSchema(schema) {
  if (!isPlainObject(schema)) return permissiveSchema();
  if (!hasCombinator(schema) && typeof schema[REF] !== "string") {
    return schema.type === undefined && isPlainObject(schema.properties) ? { ...schema, type: OBJECT } : schema;
  }
  try {
    const root = structuredClone(schema);
    const ctx = createContext(root);
    const top = resolveTop(root, ctx);
    const flat = top && flatten(top, ctx, 0);
    if (!flat) return permissiveSchema(fallbackDescription(top || root));
    const out = dropUnusedDefs(repairRefs({ ...flat, type: OBJECT }, ctx), ctx);
    return ctx.exhausted ? permissiveSchema(fallbackDescription(top)) : out;
  } catch {
    return permissiveSchema(typeof schema.description === "string" ? schema.description : "");
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
