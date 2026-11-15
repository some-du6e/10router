// JSON Schema helpers shared by the tool translators.
import { JSON_SCHEMA_TYPE, JSON_SCHEMA_COMBINATOR, JSON_SCHEMA_REF, JSON_SCHEMA_DEFS } from "../schema/index.js";
import { CLAUDE_TOOL_SCHEMA_LIMITS as LIMITS, CLAUDE_TOOL_SCHEMA_TEXT as TEXT } from "../../config/claudeToolSchema.js";
import { dbg } from "../../utils/debugLog.js";

const { ALL_OF, ANY_OF, ONE_OF } = JSON_SCHEMA_COMBINATOR;
const OBJECT = JSON_SCHEMA_TYPE.OBJECT;
const REF = JSON_SCHEMA_REF;
const COMBINATORS = new Set([ALL_OF, ANY_OF, ONE_OF]);
const ALTERNATIVES = [ANY_OF, ONE_OF];
const DEFS_KEYS = Object.values(JSON_SCHEMA_DEFS);
const GENERIC_LABELS = new Set([TEXT.OBJECT, TEXT.VALUE]);
const IN_PROGRESS = Symbol("in progress");
const INDEX = /^\d+$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const hasCombinator = (schema) => has(schema, ALL_OF) || has(schema, ANY_OF) || has(schema, ONE_OF);
const isObjectType = (type) => type === undefined || type === OBJECT || (Array.isArray(type) && type.includes(OBJECT));
const isLocalRef = (node) => isPlainObject(node) && typeof node[REF] === "string" && node[REF].startsWith("#");
const nonEmpty = (text) => typeof text === "string" && text.trim() !== "";

// allOf semantics: the union of the members' properties (a later member wins a
// clash) and of their required keys, first-seen order. Non-object members are
// skipped. `charge(n)` (optional) is told the work each member costs and stops
// the merge by returning false.
export function mergeAllOfMembers(members, charge = () => true) {
  const merged = {};
  let required = null;
  for (const item of Array.isArray(members) ? members : []) {
    if (!isPlainObject(item)) continue;
    const props = isPlainObject(item.properties) ? item.properties : null;
    const keys = props ? Object.keys(props) : [];
    const req = Array.isArray(item.required) ? item.required : [];
    if (!charge(1 + keys.length + req.length)) return merged;
    if (props) {
      merged.properties ??= {};
      for (const key of keys) merged.properties[key] = props[key];
    }
    if (Array.isArray(item.required)) {
      required ??= new Set();
      for (const key of req) required.add(key);
    }
  }
  if (required) merged.required = [...required];
  return merged;
}

function permissiveSchema(description) {
  const schema = { type: OBJECT, properties: {}, additionalProperties: true };
  if (description) schema.description = description;
  return schema;
}

// ── Descriptions ────────────────────────────────────────────────────────────

const truncate = (text, max = LIMITS.MAX_LABEL) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function label(member) {
  if (!isPlainObject(member)) return TEXT.VALUE;
  for (const text of [member.title, member.description]) {
    if (nonEmpty(text)) return truncate(text.trim());
  }
  if (Array.isArray(member.required) && member.required.length) {
    return `{${truncate(member.required.slice(0, LIMITS.MAX_LABEL_KEYS).map(String).join(", "))}}`;
  }
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
  const listed = labels.slice(0, LIMITS.MAX_LISTED);
  const more = labels.length - listed.length;
  if (more > 0) listed.push(TEXT.MORE.replace("{n}", String(more)));
  return `${prefix}: ${listed.join("; ")}.`;
}

// The schema's own description, then the notes (deduped, capped in length).
function describe(description, notes) {
  const extra = truncate([...new Set(notes.filter(nonEmpty))].join("\n\n"), LIMITS.MAX_NOTES);
  return [description, extra].filter(nonEmpty).join("\n\n");
}

// The original intent, in words, for the permissive fallback.
function fallbackDescription(schema) {
  if (!isPlainObject(schema)) return "";
  const notes = [summarize(TEXT.ALL_OF, schema[ALL_OF])];
  for (const key of ALTERNATIVES) notes.push(summarize(TEXT.ONE_OF, schema[key]));
  return describe(schema.description, notes);
}

const fallback = (schema) => permissiveSchema(fallbackDescription(schema));

// ── Size ────────────────────────────────────────────────────────────────────

// Nodes in the input; -1 when it's too big to flatten or not a tree (a node
// reached twice: shared or cyclic, which parsed JSON never is).
function countInput(schema) {
  const stack = [schema];
  const seen = new Set();
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") {
      bytes += typeof node === "string" ? node.length + 2 : 8;
      if (bytes > LIMITS.MAX_INPUT_BYTES) return -1;
      continue;
    }
    if (seen.has(node) || ++nodes > LIMITS.MAX_INPUT_NODES) return -1;
    seen.add(node);
    for (const key of Object.keys(node)) {
      bytes += key.length + 4;
      stack.push(node[key]);
    }
    if (bytes > LIMITS.MAX_INPUT_BYTES) return -1;
  }
  return nodes;
}

// Whether `node` serializes to at most `limit` nodes (a subtree reached twice counts twice).
function fitsIn(node, limit) {
  const stack = [node];
  let count = 0;
  while (stack.length) {
    const next = stack.pop();
    if (next === null || typeof next !== "object") continue;
    if (++count > limit) return false;
    for (const child of Object.values(next)) stack.push(child);
  }
  return true;
}

// Every distinct node in `node` for which `test` holds, skipping `skip` subtrees.
function findNodes(node, test, skip = new Set()) {
  const found = [];
  const stack = [node];
  const seen = new Set(skip);
  while (stack.length) {
    const next = stack.pop();
    if (next === null || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    if (test(next)) found.push(next);
    for (const child of Object.values(next)) stack.push(child);
  }
  return found;
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

const formatPointer = (keys, from = 0) => {
  let out = "#";
  for (let i = from; i < keys.length; i++) out += `/${keys[i].replace(/~/g, "~0").replace(/\//g, "~1")}`;
  return out;
};

// What keys[from..] points at under root, or undefined.
function resolveKeys(root, keys, from = 0) {
  let target = root;
  for (let i = from; i < keys.length; i++) {
    const key = keys[i];
    if (Array.isArray(target) && INDEX.test(key) && Number(key) < target.length) target = target[Number(key)];
    else if (isPlainObject(target) && has(target, key)) target = target[key];
    else return undefined;
  }
  return target;
}

function resolvePointer(root, ref) {
  const keys = parsePointer(ref);
  return keys ? resolveKeys(root, keys) : undefined;
}

// ── Flattening ──────────────────────────────────────────────────────────────

function createContext(root) {
  const ctx = { root, steps: 0, exhausted: false, memo: new Map(), keys: new WeakMap() };
  ctx.charge = (n = 1) => {
    ctx.steps += n;
    if (ctx.steps > LIMITS.MAX_STEPS) ctx.exhausted = true;
    return !ctx.exhausted;
  };
  return ctx;
}

// A short identity for a property definition: its JSON when that's at most
// MAX_KEY_LENGTH long, else null (then only the same object matches). Each
// object is keyed once, so keying costs at most the input's size.
function shortKey(value, ctx, depth = 0) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > LIMITS.MAX_KEY_LENGTH) return null;
    return JSON.stringify(value) ?? "null";
  }
  if (ctx.keys.has(value)) return ctx.keys.get(value);
  let key = null;
  if (depth < LIMITS.MAX_DEPTH) {
    const isArray = Array.isArray(value);
    let out = isArray ? "[" : "{";
    for (const k of Object.keys(value)) {
      const child = shortKey(value[k], ctx, depth + 1);
      if (child === null || k.length > LIMITS.MAX_KEY_LENGTH) { out = null; break; }
      out += `${isArray ? "" : `${JSON.stringify(k)}:`}${child},`;
      if (out.length > LIMITS.MAX_KEY_LENGTH) { out = null; break; }
    }
    if (out !== null) key = out + (isArray ? "]" : "}");
  }
  ctx.keys.set(value, key);
  return key;
}

// Every alternative's properties. A name the alternatives define differently
// keeps each definition as a property-level anyOf, which is allowed nested.
function alternativeProperties(members, ctx) {
  const defs = new Map();
  for (const member of members) {
    if (!isPlainObject(member.properties)) continue;
    const names = Object.keys(member.properties);
    if (!ctx.charge(names.length)) return null;
    for (const name of names) {
      const def = member.properties[name];
      const entry = defs.get(name) || { list: [], keys: new Set(), objects: new Set() };
      const key = shortKey(def, ctx);
      if (key !== null ? entry.keys.has(key) : entry.objects.has(def)) continue;
      if (key !== null) entry.keys.add(key);
      else entry.objects.add(def);
      entry.list.push(def);
      defs.set(name, entry);
    }
  }
  const properties = {};
  for (const [name, { list }] of defs) properties[name] = list.length === 1 ? list[0] : { [ANY_OF]: list };
  return properties;
}

// The keys every member requires (Set-based, charged per key).
function sharedRequired(members, ctx) {
  let shared = null;
  for (const member of members) {
    const req = Array.isArray(member.required) ? member.required : [];
    if (!ctx.charge(req.length + 1)) return null;
    const own = new Set(req);
    shared = shared === null ? own : new Set([...shared].filter((k) => own.has(k)));
  }
  return [...(shared || [])];
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
  const merged = mergeAllOfMembers([target, rest], ctx.charge);
  if (ctx.exhausted) return null;
  const out = { ...target, ...rest };
  if (merged.properties) out.properties = merged.properties;
  if (merged.required) out.required = merged.required;
  return out;
}

// One object schema equivalent enough to `schema` with no top-level combinator,
// or null when a member isn't an object schema we can flatten (or the budget ran out).
function flatten(schema, ctx, depth) {
  if (!ctx.charge() || depth > LIMITS.MAX_DEPTH || !isPlainObject(schema)) return null;
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
    const required = sharedRequired(members, ctx);
    const properties = required && alternativeProperties(members, ctx);
    if (!properties) return null;
    parts.push({ properties, required });
    // Alternatives that flatten to the same thing aren't a choice worth describing.
    notes.push(summarize(TEXT.ONE_OF, members, 2));
  }

  const merged = mergeAllOfMembers(parts, ctx.charge);
  if (ctx.exhausted) return null;
  const out = { ...base, type: OBJECT, properties: merged.properties || {} };
  if (merged.required?.length) out.required = merged.required;
  else delete out.required;
  const description = describe(base.description, notes);
  if (description) out.description = description;
  else delete out.description;
  return out;
}

// A top-level $ref, followed to the schema it names. The root's other keys
// (its definitions block, a description) stay next to it.
function resolveTop(root, ctx) {
  let top = root;
  for (let hops = 0; typeof top[REF] === "string"; hops++) {
    if (hops >= LIMITS.MAX_DEPTH || !ctx.charge()) return null;
    const target = resolvePointer(root, top[REF]);
    if (!isPlainObject(target)) return null;
    const { [REF]: _ref, ...siblings } = top;
    top = { ...target, ...siblings };
  }
  return top;
}

// A definitions block nothing outside it points into is dropped (a block
// another kept block points into stays).
function dropUnusedDefs(out) {
  const blocks = DEFS_KEYS.filter((key) => isPlainObject(out[key]));
  if (!blocks.length) return;
  const prefixOf = (key) => formatPointer([key]);
  const pointsInto = (refs, key) => refs.some((ref) => ref === prefixOf(key) || ref.startsWith(`${prefixOf(key)}/`));
  const refsIn = (node, skip) => findNodes(node, isLocalRef, skip).map((n) => n[REF]);
  const used = new Set();
  let refs = refsIn(out, new Set(blocks.map((key) => out[key])));
  for (let pass = 0; pass < blocks.length; pass++) {
    const newly = blocks.filter((key) => !used.has(key) && pointsInto(refs, key));
    if (!newly.length) break;
    newly.forEach((key) => used.add(key));
    refs = newly.flatMap((key) => refsIn(out[key]));
  }
  for (const key of blocks) if (!used.has(key)) delete out[key];
}

// A $ref that no longer resolves pointed into a combinator member that was
// merged away. It's pointed at the same path in the merged schema
// ("#/anyOf/0/properties/a" → "#/properties/a", which zod-to-json-schema
// writes) when that exists. Anything else (a ref to a member itself, as a
// recursive union writes, or one that pointed nowhere) fails: false.
function retargetRefs(out) {
  for (const node of findNodes(out, isLocalRef)) {
    const keys = parsePointer(node[REF]);
    if (!keys) return false;
    if (resolveKeys(out, keys) !== undefined) continue;
    let from = 0;
    while (from + 1 < keys.length && COMBINATORS.has(keys[from]) && INDEX.test(keys[from + 1])) from += 2;
    if (from === 0 || from === keys.length || resolveKeys(out, keys, from) === undefined) return false;
    node[REF] = formatPointer(keys, from);
  }
  return true;
}

// A top level without combinators only needs an object type.
function withObjectType(schema) {
  if (schema.type === undefined && isPlainObject(schema.properties)) return { ...schema, type: OBJECT };
  if (Array.isArray(schema.type) && schema.type.includes(OBJECT)) return { ...schema, type: OBJECT };
  return schema;
}

// A Claude tool's input_schema must be a plain object schema at the top level:
// Anthropic-style Messages APIs reject allOf/anyOf/oneOf there (nested inside
// properties they're fine, and left alone). Returns the schema itself when
// nothing needs changing, otherwise a new schema; never mutates or throws.
export function normalizeClaudeInputSchema(schema) {
  if (!isPlainObject(schema)) return permissiveSchema();
  if (!hasCombinator(schema) && typeof schema[REF] !== "string") return withObjectType(schema);
  try {
    const nodes = countInput(schema);
    if (nodes < 0) return fallback(schema);
    const root = structuredClone(schema);
    const ctx = createContext(root);
    const top = resolveTop(root, ctx);
    const flat = top && flatten(top, ctx, 0);
    if (!flat) return fallback(top || root);
    const out = { ...flat, type: OBJECT };
    if (!fitsIn(out, LIMITS.MAX_GROWTH * nodes + 64)) return fallback(top);
    dropUnusedDefs(out);
    return retargetRefs(out) ? out : fallback(top);
  } catch {
    return permissiveSchema(nonEmpty(schema.description) ? schema.description : "");
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
