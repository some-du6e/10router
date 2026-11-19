// JSON Schema helpers shared by the tool translators.
import {
  JSON_SCHEMA_TYPE, JSON_SCHEMA_COMBINATOR, JSON_SCHEMA_REF, JSON_SCHEMA_DEFS,
  JSON_SCHEMA_SCHEMA_MAP, JSON_SCHEMA_LITERAL, JSON_SCHEMA_EXTENSION_PREFIX,
} from "../schema/index.js";
import { CLAUDE_TOOL_SCHEMA_LIMITS as LIMITS, CLAUDE_TOOL_SCHEMA_TEXT as TEXT } from "../../config/claudeToolSchema.js";
import { dbg } from "../../utils/debugLog.js";

// Schemas are arbitrary client JSON, read field by field.
type Schema = Record<string, any>;
type Charge = (n?: number) => boolean;
type Context = {
  root: Schema;
  steps: number;
  exhausted: boolean;
  memo: Map<string, Schema | null | typeof IN_PROGRESS>;
  keys: WeakMap<object, string | null>;
  charge: Charge;
};

const { ALL_OF, ANY_OF, ONE_OF } = JSON_SCHEMA_COMBINATOR;
const OBJECT = JSON_SCHEMA_TYPE.OBJECT;
const REF = JSON_SCHEMA_REF;
const PROPERTIES = JSON_SCHEMA_SCHEMA_MAP.PROPERTIES;
const COMBINATORS = new Set<string>([ALL_OF, ANY_OF, ONE_OF]);
const ALTERNATIVES = [ANY_OF, ONE_OF];
const DEFS_KEYS: string[] = Object.values(JSON_SCHEMA_DEFS);
// Keywords whose value maps names to subschemas (any name, even "const").
const SCHEMA_MAPS = new Set<string>([...Object.values(JSON_SCHEMA_SCHEMA_MAP), ...DEFS_KEYS]);
// Keywords whose value is instance data, never a subschema.
const LITERALS = new Set<string>(Object.values(JSON_SCHEMA_LITERAL));
const GENERIC_LABELS = new Set<string>([TEXT.OBJECT, TEXT.VALUE]);
const IN_PROGRESS: unique symbol = Symbol("in progress");
const INDEX = /^\d+$/;

const isPlainObject = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const hasCombinator = (schema: Schema) => has(schema, ALL_OF) || has(schema, ANY_OF) || has(schema, ONE_OF);
// "" is the document itself, like "#".
const isLocalPointer = (ref: unknown) => typeof ref === "string" && (ref === "" || ref.startsWith("#"));
const hasRef = (node: unknown): node is Schema => isPlainObject(node) && typeof node[REF] === "string";
// Vendor extension keywords ("x-…") hold annotation data, not subschemas.
const isExtension = (key: string) => key.startsWith(JSON_SCHEMA_EXTENSION_PREFIX);

// Strings come from the client, so only a bounded prefix is ever scanned.
const head = (text: unknown, max: number) => (typeof text === "string" ? text.slice(0, max) : "");
const nonEmpty = (text: unknown) => /\S/.test(head(text, LIMITS.MAX_BLANK_SCAN));
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// An own property, even one named "__proto__" (plain assignment would set the prototype).
function setOwn(obj: Schema, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

// allOf semantics: the union of the members' properties (a later member wins a
// clash) and of their required keys, first-seen order. Non-object members are
// skipped. `charge(n)` (optional) is told the work each member costs and stops
// the merge by returning false.
export function mergeAllOfMembers(members: unknown, charge: Charge = () => true): { properties?: Schema; required?: unknown[] } {
  const merged: { properties?: Schema; required?: unknown[] } = {};
  let required: Set<unknown> | null = null;
  for (const item of Array.isArray(members) ? members : []) {
    if (!isPlainObject(item)) continue;
    const props = isPlainObject(item.properties) ? item.properties : null;
    const keys = props ? Object.keys(props) : [];
    const req: unknown[] = Array.isArray(item.required) ? item.required : [];
    if (!charge(1 + keys.length + req.length)) return merged;
    if (props) {
      const target: Schema = (merged.properties ??= {});
      for (const key of keys) setOwn(target, key, props[key]);
    }
    if (Array.isArray(item.required)) {
      required ??= new Set();
      for (const key of req) required.add(key);
    }
  }
  if (required) merged.required = [...required];
  return merged;
}

function permissiveSchema(description?: string): Schema {
  const schema: Schema = { type: OBJECT, properties: {}, additionalProperties: true };
  if (description) schema.description = description;
  return schema;
}

// ── Descriptions ────────────────────────────────────────────────────────────

const labelText = (text: unknown) => truncate(head(text, 2 * LIMITS.MAX_LABEL).trim(), LIMITS.MAX_LABEL);
// The first few entries of a list, each a bounded string (a non-string is named by its typeof).
const listText = (list: unknown[]) => list.slice(0, LIMITS.MAX_LABEL_KEYS)
  .map((t) => (typeof t === "string" ? labelText(t) : typeof t)).join(", ");

// Labels are cached per member object: a shared $ref target is labelled once.
const labels = new WeakMap<object, string>();

function label(member: unknown): string {
  if (!isPlainObject(member)) return TEXT.VALUE;
  let text = labels.get(member);
  if (text === undefined) {
    text = computeLabel(member);
    labels.set(member, text);
  }
  return text;
}

function computeLabel(member: Schema): string {
  for (const text of [member.title, member.description]) {
    if (nonEmpty(text)) return labelText(text);
  }
  if (Array.isArray(member.required) && member.required.length) {
    return `{${truncate(listText(member.required), LIMITS.MAX_LABEL)}}`;
  }
  if (typeof member[REF] === "string") return labelText(member[REF]);
  if (member.type !== undefined && member.type !== OBJECT) {
    const type = truncate(listText(Array.isArray(member.type) ? member.type : [member.type]), LIMITS.MAX_LABEL);
    return TEXT.TYPED.replace("{type}", () => type);
  }
  return TEXT.OBJECT;
}

// "Accepts one of: A; B." Empty when the members give nothing to tell apart:
// no members, only generic labels, or fewer distinct ones than `minDistinct`.
function summarize(prefix: string, members: unknown, minDistinct = 1): string {
  if (!Array.isArray(members) || !members.length) return "";
  const labels = [...new Set(members.map(label))];
  if (labels.length < minDistinct || labels.every((l) => GENERIC_LABELS.has(l))) return "";
  const listed = labels.slice(0, LIMITS.MAX_LISTED);
  const more = labels.length - listed.length;
  if (more > 0) listed.push(TEXT.MORE.replace("{n}", () => String(more)));
  return `${prefix}: ${listed.join("; ")}.`;
}

// The schema's own description, then the notes (deduped, capped in length).
function describe(description: unknown, notes: unknown[]): string {
  const kept = [...new Set(notes.filter(nonEmpty).map((n) => head(n, LIMITS.MAX_NOTES + 1)))];
  const extra = truncate(kept.join("\n\n"), LIMITS.MAX_NOTES);
  return [description, extra].filter(nonEmpty).join("\n\n");
}

const fallbackText = (description: unknown) => (nonEmpty(description) ? truncate(description as string, LIMITS.MAX_FALLBACK_DESCRIPTION) : "");

// The permissive fallback, with the original intent in words.
function fallback(schema: Schema): Schema {
  const notes = [summarize(TEXT.ALL_OF, schema[ALL_OF])];
  for (const key of ALTERNATIVES) notes.push(summarize(TEXT.ONE_OF, schema[key]));
  return permissiveSchema(describe(fallbackText(schema.description), notes));
}

// ── Size ────────────────────────────────────────────────────────────────────

// Nodes (objects and arrays) in the input; -1 as soon as it's over either cap,
// or isn't a tree (a node reached twice: shared or cyclic, which parsed JSON never is).
function countInput(schema: Schema): number {
  const stack: unknown[] = [schema];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") {
      bytes += typeof node === "string" ? node.length + 2 : 8;
    } else {
      if (seen.has(node) || ++nodes > LIMITS.MAX_INPUT_NODES) return -1;
      seen.add(node);
      if (Array.isArray(node)) {
        bytes += 2 + node.length;
        if (bytes > LIMITS.MAX_INPUT_BYTES) return -1;
        for (let i = 0; i < node.length; i++) stack.push(node[i]);
      } else {
        bytes += 2;
        for (const key in node) {
          if (!has(node, key)) continue;
          bytes += key.length + 4;
          if (bytes > LIMITS.MAX_INPUT_BYTES) return -1;
          stack.push((node as Schema)[key]);
        }
      }
    }
    if (bytes > LIMITS.MAX_INPUT_BYTES) return -1;
  }
  return nodes;
}

// Whether `node` serializes to at most `limit` nodes (a subtree reached twice counts twice).
function fitsIn(node: Schema, limit: number): boolean {
  const stack: unknown[] = [node];
  let count = 0;
  while (stack.length) {
    const next = stack.pop();
    if (next === null || typeof next !== "object") continue;
    if (++count > limit) return false;
    for (const child of Object.values(next)) stack.push(child);
  }
  return true;
}

// Every distinct subschema in `node` holding a $ref (local or not), skipping
// `skip` subtrees. Only schema positions are visited: the values under const,
// enum, default, examples and vendor "x-" keywords are data, and a $ref there
// isn't a reference. `isMap` says `node` itself maps names to subschemas (a
// definitions block).
function findRefNodes(node: Schema, skip: Set<object> = new Set(), isMap = false): Schema[] {
  const found: Schema[] = [];
  // [value, whether value maps names to subschemas]
  const stack: [unknown, boolean][] = [[node, isMap]];
  const seen = new Set<object>(skip);
  while (stack.length) {
    const [next, isMap] = stack.pop()!;
    if (next === null || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    if (Array.isArray(next)) {
      for (const child of next) stack.push([child, false]);
      continue;
    }
    if (!isMap && hasRef(next)) found.push(next);
    for (const [key, child] of Object.entries(next)) {
      if (isMap) stack.push([child, false]);
      else if (!LITERALS.has(key) && !isExtension(key)) stack.push([child, SCHEMA_MAPS.has(key)]);
    }
  }
  return found;
}

// ── JSON pointers ───────────────────────────────────────────────────────────

// "#/a/b~1c" → ["a", "b/c"]; "" and "#" → []; null when not a local pointer
// (one that doesn't start with "#") or malformed.
function parsePointer(ref: unknown): string[] | null {
  if (typeof ref !== "string" || !isLocalPointer(ref)) return null;
  if (ref === "" || ref === "#") return [];
  if (!ref.startsWith("#/")) return null;
  try {
    return ref.slice(2).split("/").map((raw) => decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"));
  } catch {
    return null;
  }
}

const escapeToken = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

// The canonical spelling of keys[from..], for comparing pointers: "%41" and "A" give the same one.
function formatPointer(keys: string[], from = 0): string {
  let out = "#";
  for (let i = from; i < keys.length; i++) out += `/${escapeToken(keys[i])}`;
  return out;
}

// keys[from..] as a URI fragment, for writing into a $ref.
function fragmentPointer(keys: string[], from = 0): string {
  let out = "#";
  for (let i = from; i < keys.length; i++) out += `/${encodeURIComponent(escapeToken(keys[i]))}`;
  return out;
}

// What keys[from..to) points at under root, or undefined.
function resolveKeys(root: unknown, keys: string[], from = 0, to = keys.length): unknown {
  let target = root;
  for (let i = from; i < to; i++) {
    const key = keys[i];
    if (Array.isArray(target) && INDEX.test(key) && Number(key) < target.length) target = target[Number(key)];
    else if (isPlainObject(target) && has(target, key)) target = target[key];
    else return undefined;
  }
  return target;
}

// ── Flattening ──────────────────────────────────────────────────────────────

function createContext(root: Schema): Context {
  const ctx: Context = { root, steps: 0, exhausted: false, memo: new Map(), keys: new WeakMap(), charge: () => true };
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
function shortKey(value: unknown, ctx: Context, depth = 0): string | null {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > LIMITS.MAX_KEY_LENGTH) return null;
    return JSON.stringify(value) ?? "null";
  }
  if (ctx.keys.has(value)) return ctx.keys.get(value) ?? null;
  let key: string | null = null;
  if (depth < LIMITS.MAX_DEPTH) {
    const isArray = Array.isArray(value);
    let out: string | null = isArray ? "[" : "{";
    for (const k of Object.keys(value)) {
      const child = k.length > LIMITS.MAX_KEY_LENGTH ? null : shortKey((value as Schema)[k], ctx, depth + 1);
      if (child === null) { out = null; break; }
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
function alternativeProperties(members: Schema[], ctx: Context): Schema | null {
  const defs = new Map<string, { list: unknown[]; keys: Set<string>; objects: Set<unknown> }>();
  for (const member of members) {
    if (!isPlainObject(member.properties)) continue;
    const names = Object.keys(member.properties);
    if (!ctx.charge(names.length)) return null;
    for (const name of names) {
      const def = member.properties[name];
      const entry = defs.get(name) || { list: [], keys: new Set<string>(), objects: new Set<unknown>() };
      const key = shortKey(def, ctx);
      if (key !== null ? entry.keys.has(key) : entry.objects.has(def)) continue;
      if (key !== null) entry.keys.add(key);
      else entry.objects.add(def);
      entry.list.push(def);
      defs.set(name, entry);
    }
  }
  const properties: Schema = {};
  for (const [name, { list }] of defs) setOwn(properties, name, list.length === 1 ? list[0] : { [ANY_OF]: list });
  return properties;
}

// The keys every member requires (Set-based, charged per key).
function sharedRequired(members: Schema[], ctx: Context): unknown[] | null {
  let shared = new Set<unknown>();
  members.forEach((member, i) => {
    if (ctx.exhausted) return;
    const req: unknown[] = Array.isArray(member.required) ? member.required : [];
    if (!ctx.charge(1 + req.length + shared.size)) return;
    const own = new Set<unknown>(req);
    shared = i === 0 ? own : new Set<unknown>([...shared].filter((k) => own.has(k)));
  });
  return ctx.exhausted ? null : [...shared];
}

// `target` with `rest`'s keys on top; properties and required merged, `rest`
// winning a clash. Charged per key copied.
function mergeOnto(target: Schema, rest: Schema, ctx: Context): Schema | null {
  const targetKeys = Object.keys(target);
  const restKeys = Object.keys(rest);
  if (!ctx.charge(targetKeys.length + restKeys.length)) return null;
  const merged = mergeAllOfMembers([target, rest], ctx.charge);
  if (ctx.exhausted) return null;
  const out: Schema = {};
  for (const key of targetKeys) setOwn(out, key, target[key]);
  for (const key of restKeys) setOwn(out, key, rest[key]);
  if (merged.properties) out.properties = merged.properties;
  if (merged.required) out.required = merged.required;
  return out;
}

// A $ref member: its target is flattened once per pointer (however it's
// spelled) and reused.
function flattenRef(schema: Schema, ctx: Context, depth: number): Schema | null {
  const keys = parsePointer(schema[REF]);
  if (!keys) return null;
  const pointer = formatPointer(keys);
  let target = ctx.memo.get(pointer);
  if (target === IN_PROGRESS) return null;
  if (target === undefined) {
    ctx.memo.set(pointer, IN_PROGRESS);
    const resolved = resolveKeys(ctx.root, keys);
    // Same depth: the member holding the ref already counted this level.
    target = isPlainObject(resolved) ? flatten(resolved, ctx, depth) : null;
    ctx.memo.set(pointer, target);
  }
  if (!target) return null;
  const siblingKeys = Object.keys(schema).filter((k) => k !== REF);
  if (!siblingKeys.length) return target;
  if (!ctx.charge(siblingKeys.length)) return null;
  const siblings: Schema = {};
  for (const key of siblingKeys) setOwn(siblings, key, schema[key]);
  const rest = flatten(siblings, ctx, depth + 1);
  return rest && mergeOnto(target, rest, ctx);
}

function isObjectType(type: unknown, ctx: Context): boolean {
  if (type === undefined || type === OBJECT) return true;
  if (!Array.isArray(type) || !ctx.charge(type.length)) return false;
  return type.includes(OBJECT);
}

// One object schema equivalent enough to `schema` with no top-level combinator,
// or null when a member isn't an object schema we can flatten (or the budget ran out).
function flatten(schema: unknown, ctx: Context, depth: number): Schema | null {
  if (depth > LIMITS.MAX_DEPTH || !isPlainObject(schema) || !ctx.charge()) return null;
  if (typeof schema[REF] === "string") return flattenRef(schema, ctx, depth);
  if (!isObjectType(schema.type, ctx)) return null;
  if (!hasCombinator(schema)) return schema;

  const ownKeys = Object.keys(schema);
  if (!ctx.charge(ownKeys.length)) return null;
  const base: Schema = {};
  for (const key of ownKeys) if (!COMBINATORS.has(key)) setOwn(base, key, schema[key]);
  const parts: Schema[] = [base];
  const notes: unknown[] = [];

  const flattenAll = (members: unknown): Schema[] | null => {
    if (!Array.isArray(members) || members.length === 0) return null;
    const out: Schema[] = [];
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
    if (!ctx.charge(members.length)) return null;
    notes.push(summarize(TEXT.ONE_OF, members, 2));
  }

  const merged = mergeAllOfMembers(parts, ctx.charge);
  if (ctx.exhausted) return null;
  const out = base;
  out.type = OBJECT;
  out.properties = merged.properties || {};
  if (merged.required?.length) out.required = merged.required;
  else delete out.required;
  const description = describe(base.description, notes);
  if (description) out.description = description;
  else delete out.description;
  return out;
}

// A top-level $ref, followed to the schema it names. The root's other keys
// stay next to it (its definitions block, a description), and its properties
// and required merge with the target's, as for a $ref member's siblings.
function resolveTop(root: Schema, ctx: Context): Schema | null {
  let top: Schema | null = root;
  for (let hops = 0; typeof top[REF] === "string"; hops++) {
    const keys = parsePointer(top[REF]);
    const target = keys && resolveKeys(root, keys);
    // A ref to the document itself ("" or "#") never reaches an object schema.
    if (hops >= LIMITS.MAX_DEPTH || !isPlainObject(target) || target === root) return null;
    const rest: Schema = {};
    for (const key of Object.keys(top)) if (key !== REF) setOwn(rest, key, top[key]);
    top = mergeOnto(target, rest, ctx);
    if (!top) return null;
  }
  return top;
}

// A definitions block nothing outside it points into is dropped (a block
// another kept block points into stays). Refs are compared by their decoded
// first token, so "#/%24defs/A" counts for "$defs".
function dropUnusedDefs(out: Schema) {
  const blocks = DEFS_KEYS.filter((key) => isPlainObject(out[key]));
  if (!blocks.length) return;
  const firstTokens = (node: Schema, skip?: Set<object>, isMap?: boolean) =>
    findRefNodes(node, skip, isMap).map((n) => parsePointer(n[REF])?.[0]);
  const used = new Set<string>();
  let tokens = firstTokens(out, new Set(blocks.map((key) => out[key])));
  for (let pass = 0; pass < blocks.length; pass++) {
    const newly = blocks.filter((key) => !used.has(key) && tokens.includes(key));
    if (!newly.length) break;
    newly.forEach((key) => used.add(key));
    tokens = newly.flatMap((key) => firstTokens(out[key], undefined, true));
  }
  for (const key of blocks) if (!used.has(key)) delete out[key];
}

// Every $ref left in the output must mean exactly what it meant in the input.
// One that doesn't start with "#" (another document, say) can't be
// checked, so it fails. One that still resolves must reach the very same
// object it did. One that doesn't resolve pointed into a combinator member
// that was merged away; it's
// retargeted only to a property the merged schema holds as the very same
// object: "#/anyOf/0/properties/a/..." → "#/properties/a/...", which
// zod-to-json-schema writes. Anything else fails (false): a ref to a member
// itself (a recursive union), into a member's own $defs, through a property
// the alternatives define differently, or one that pointed nowhere.
function retargetRefs(out: Schema, root: Schema): boolean {
  for (const node of findRefNodes(out)) {
    const keys = parsePointer(node[REF]);
    if (!keys) return false;
    const kept = resolveKeys(out, keys);
    if (kept !== undefined) {
      if (kept !== resolveKeys(root, keys)) return false;
      continue;
    }
    let from = 0;
    while (from + 1 < keys.length && COMBINATORS.has(keys[from]) && INDEX.test(keys[from + 1])) from += 2;
    if (from === 0 || keys[from] !== PROPERTIES || keys.length < from + 2) return false;
    const original = resolveKeys(root, keys, 0, from + 2);
    if (original === undefined || original !== resolveKeys(out, keys, from, from + 2)) return false;
    if (resolveKeys(out, keys, from) === undefined) return false;
    node[REF] = fragmentPointer(keys, from);
  }
  return true;
}

// A top level without combinators only needs an object type.
function withObjectType(schema: Schema): Schema {
  if (schema.type === undefined && isPlainObject(schema.properties)) return { ...schema, type: OBJECT };
  if (Array.isArray(schema.type) && schema.type.includes(OBJECT)) return { ...schema, type: OBJECT };
  return schema;
}

// A Claude tool's input_schema must be a plain object schema at the top level:
// Anthropic-style Messages APIs reject allOf/anyOf/oneOf there (nested inside
// properties they're fine, and left alone). Returns the schema itself when
// nothing needs changing, otherwise a new schema; never mutates or throws.
// Only small schemas (MAX_INPUT_BYTES / MAX_INPUT_NODES) are flattened.
export function normalizeClaudeInputSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return permissiveSchema();
  if (!hasCombinator(schema) && typeof schema[REF] !== "string") return withObjectType(schema);
  try {
    const nodes = countInput(schema);
    if (nodes < 0) return permissiveSchema(fallbackText(schema.description));
    const root: Schema = structuredClone(schema);
    const ctx = createContext(root);
    const top = resolveTop(root, ctx);
    const flat = top && flatten(top, ctx, 0);
    if (!top || !flat) return fallback(top || root);
    const out: Schema = { ...flat, type: OBJECT };
    if (!fitsIn(out, LIMITS.MAX_GROWTH * nodes + 64)) return fallback(top);
    dropUnusedDefs(out);
    return retargetRefs(out, root) ? out : fallback(top);
  } catch {
    return permissiveSchema(fallbackText(schema.description));
  }
}

// The tool with a normalized input_schema; the tool itself when unchanged or schemaless.
export function normalizeClaudeToolSchema<T>(tool: T): T {
  if (!isPlainObject(tool) || tool.input_schema === undefined) return tool;
  const inputSchema = normalizeClaudeInputSchema(tool.input_schema);
  return inputSchema === tool.input_schema ? tool : ({ ...tool, input_schema: inputSchema } as T);
}

// Same array back when no tool changed, so untouched requests stay byte-identical.
export function normalizeClaudeToolSchemas<T>(tools: T): T {
  if (!Array.isArray(tools)) return tools;
  const out = tools.map(normalizeClaudeToolSchema);
  const changed = out.filter((tool, i) => tool !== tools[i]).length;
  if (!changed) return tools;
  dbg("TOOLSCHEMA", `normalized input_schema of ${changed} tool(s)`);
  return out as T;
}
