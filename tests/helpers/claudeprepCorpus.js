// Synthetic /v1/messages traffic for the Go gateway's Claude request
// preparation (gateway/internal/claudeprep), shaped like production: long
// Claude Code histories, 12-48 tools, thinking with signatures, cache_control
// everywhere, images, tool errors, broken ids, endpoint overrides and every
// thinking-capability family. Everything here is made up: no real keys, hosts,
// accounts or prompts.
//
// Bodies are written as JSON text by a writer of our own, not JSON.stringify,
// so a fixture can carry what clients send and JSON.stringify never writes:
// `1.0`, `1e3`, big integers, duplicate keys, integer-like keys, escapes and
// odd whitespace. Node parses and re-serializes all of it; the Go port must
// come out with the same bytes.
//
// buildCorpus({ large }) is deterministic: the same seed gives the same text.

const RAW = Symbol("raw");
const PAIRS = Symbol("pairs");
const ESC = Symbol("esc");

/** A value written exactly as `text` (a number spelling, for one). */
export const raw = (text) => ({ [RAW]: text });
/** An object written with exactly these [key, value] members, duplicates included. */
export const pairs = (list) => ({ [PAIRS]: list });
/** A string written with its escapes as given: esc("caf\\u00e9"). */
export const esc = (text) => ({ [ESC]: text });

function quote(s) {
  return JSON.stringify(s);
}

/**
 * JSON text for `value`. style: "compact", "pretty" (2-space indent) or
 * "loose" (CRLF, tabs and spaces around every token, as some SDKs write).
 */
export function writeJson(value, style = "compact", depth = 0) {
  const nl = style === "pretty" ? "\n" + "  ".repeat(depth + 1) : style === "loose" ? "\r\n\t" : "";
  const end = style === "pretty" ? "\n" + "  ".repeat(depth) : style === "loose" ? " \r\n" : "";
  const colon = style === "compact" ? ":" : style === "loose" ? " :\t" : ": ";
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "[" + value.map((v) => nl + writeJson(v, style, depth + 1)).join(",") + end + "]";
  }
  if (value[RAW] !== undefined) return value[RAW];
  if (value[ESC] !== undefined) return `"${value[ESC]}"`;
  const members = value[PAIRS] || Object.entries(value).filter(([, v]) => v !== undefined);
  if (!members.length) return "{}";
  return "{" + members.map(([k, v]) => nl + quote(k) + colon + writeJson(v, style, depth + 1)).join(",") + end + "}";
}

// ---- Randomness -------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) { this.next = mulberry32(seed); }
  int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  pick(list) { return list[Math.floor(this.next() * list.length)]; }
  chance(p) { return this.next() < p; }
  id(prefix, n = 24) {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = prefix;
    for (let i = 0; i < n; i++) s += abc[Math.floor(this.next() * abc.length)];
    return s;
  }
}

const WORDS = [
  "alpha", "bravo", "cache", "delta", "echo", "field", "graph", "handler", "index", "join",
  "kernel", "layer", "module", "node", "offset", "parser", "queue", "record", "stream", "token",
  "update", "vector", "worker", "yield", "zone", "buffer", "config", "decode", "encode", "filter",
  "the", "a", "of", "to", "and", "in", "is", "for", "with", "on",
];
const CODE = [
  "const value = await load(path);", "if (!result) return null;", "for (const item of list) total += item.size;",
  "export function parse(text) {", "}", "  return items.filter(Boolean);", "throw new Error(\"unexpected end\");",
  "import { join } from \"node:path\";", "let count = 0;", "// TODO: handle the empty case",
];

// Text sizes: full for the large corpus CI generates, a fraction for the one
// the repo keeps (the shapes stay; only the prose gets shorter).
let SCALE = 1;
// The repo's corpus also keeps histories short where their length doesn't
// matter (the thinking and override matrices).
let SMALL = false;
const scaled = (n) => Math.max(1, Math.round(n * SCALE));

function words(rng, n) {
  const out = [];
  for (let i = 0; i < scaled(n); i++) out.push(rng.pick(WORDS));
  return out.join(" ");
}

function code(rng, lines) {
  const out = [];
  for (let i = 0; i < scaled(lines); i++) out.push(rng.pick(CODE));
  return out.join("\n");
}

function signature(rng) {
  return rng.id("Eq", scaled(rng.int(80, 320))) + "==";
}

// A tiny PNG-ish base64 payload: synthetic bytes, not a real image.
function imageData(rng) {
  return "iVBORw0KGgo" + rng.id("", scaled(rng.int(40, 200)));
}

// ---- Tools ------------------------------------------------------------------

// Claude Code's built-in tool names, plus MCP tools, some of which trigger the
// dedupe rules (open-sse/utils/toolDeduper.js).
const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite", "BashOutput", "KillShell", "ExitPlanMode", "SlashCommand"];
const MCP_TOOLS = [
  "mcp__workspace__web_fetch", "mcp__notes__search", "mcp__notes__create", "mcp__files__list",
  "mcp__browsermcp__navigate", "mcp__browsermcp__click", "mcp__Claude_in_Chrome__click", "mcp__Claude_in_Chrome__read_page",
  "mcp__exa__web_search_exa", "mcp__tavily__tavily_search", "mcp__db__query", "mcp__db__schema",
];

function schemaFor(rng, name, { numbers = false } = {}) {
  const props = {};
  const n = rng.int(1, 6);
  for (let i = 0; i < n; i++) {
    const kind = rng.pick(["string", "number", "boolean", "array", "object", "integer"]);
    const prop = { type: kind, description: words(rng, rng.int(3, 18)) };
    if (kind === "array") prop.items = { type: "string" };
    if (kind === "object") prop.properties = { mode: { type: "string", enum: ["fast", "full"] } };
    if (kind === "integer" || kind === "number") {
      if (numbers) {
        prop.minimum = raw(rng.pick(["0", "1.0", "-0", "0.0"]));
        prop.maximum = raw(rng.pick(["1e3", "1E+2", "9007199254740993", "12345678901234567890", "1.50", "100.000"]));
        prop.multipleOf = raw(rng.pick(["0.10", "1e-7", "5e-324", "2.5E-3"]));
      } else {
        prop.minimum = 0;
      }
    }
    props[`${name.toLowerCase().replace(/[^a-z]/g, "") || "p"}_${i}`] = prop;
  }
  const schema = { type: "object", properties: props, required: Object.keys(props).slice(0, 1) };
  if (rng.chance(0.4)) schema.additionalProperties = false;
  if (rng.chance(0.3)) schema.$schema = "http://json-schema.org/draft-07/schema#";
  return schema;
}

function makeTool(rng, name, opts = {}) {
  const tool = { name, description: words(rng, rng.int(10, 80)), input_schema: schemaFor(rng, name, opts) };
  if (opts.custom) return { type: "custom", ...tool };
  return tool;
}

function toolSet(rng, count, { mcp = [], numbers = false, customEvery = 0, cacheAll = false } = {}) {
  const names = [...mcp];
  for (const name of CC_TOOLS) if (names.length < count) names.push(name);
  for (let i = 0; names.length < count; i++) names.push(`mcp__extra__tool_${i}`);
  const tools = names.slice(0, count).map((name, i) => makeTool(rng, name, { numbers, custom: customEvery > 0 && i % customEvery === 0 }));
  if (cacheAll) for (const tool of tools) tool.cache_control = { type: "ephemeral" };
  else tools[tools.length - 1].cache_control = { type: "ephemeral" };
  return tools;
}

// ---- Conversations ----------------------------------------------------------

/**
 * A Claude Code history: user prompt, then assistant turns (thinking, text,
 * tool_use) answered by tool_result turns, ending with a user turn.
 * opts: messages, toolNames, thinking, images, errors, brokenIds, cacheEverywhere,
 * emptyBlocks, systemTurns.
 */
function conversation(rng, opts) {
  const {
    messages = 60, toolNames = ["Read"], thinking = true, images = 0, errors = 0.1,
    brokenIds = 0, cacheEverywhere = false, emptyBlocks = 0, systemTurns = 0, numbers = false,
  } = opts;
  const cc = (block) => (cacheEverywhere && rng.chance(0.5) ? { ...block, cache_control: rng.chance(0.5) ? { type: "ephemeral" } : { type: "ephemeral", ttl: "1h" } } : block);
  const out = [{ role: "user", content: [cc({ type: "text", text: "<system-reminder>\n" + words(rng, 60) + "\n</system-reminder>" }), cc({ type: "text", text: words(rng, 20) })] }];
  let turn = 0;
  while (out.length < messages - 1) {
    turn++;
    const assistant = [];
    if (thinking && rng.chance(0.8)) {
      const block = rng.chance(0.1)
        ? { type: "redacted_thinking", data: rng.id("RD", 60) }
        : { type: "thinking", thinking: words(rng, rng.int(10, 80)), signature: signature(rng) };
      assistant.push(cacheEverywhere && rng.chance(0.3) ? { ...block, cache_control: { type: "ephemeral" } } : block);
    }
    if (rng.chance(0.7)) assistant.push(cc({ type: "text", text: words(rng, rng.int(4, 40)) }));
    if (emptyBlocks && rng.chance(emptyBlocks)) assistant.push({ type: "text", text: rng.pick(["", " ", "\n\t "]) });
    const calls = rng.chance(0.15) ? 2 : 1;
    const ids = [];
    for (let c = 0; c < calls; c++) {
      let id = rng.id("toolu_01", 22);
      if (brokenIds && rng.chance(brokenIds)) id = rng.pick([`call.${turn}.${c}`, `fc ${turn}`, "", "!!!", `tool:use/${turn}`, null, `id-é-${turn}`]);
      ids.push(id);
      const name = rng.pick(toolNames);
      const input = numbers && rng.chance(0.5)
        ? pairs([["path", `/work/src/module_${turn}.ts`], ["limit", raw(rng.pick(["1.0", "1e3", "250", "-0", "12345678901234567890"]))], ["10", "ten"], ["2", "two"], ["offset", raw("0.50")]])
        : { path: `/work/src/module_${turn}.ts`, limit: rng.int(1, 400) };
      const block = { type: "tool_use", name, input };
      if (id !== null) block.id = id;
      assistant.push(cc(block));
    }
    // Text after tool_use is dropped by fixToolUseOrdering.
    if (rng.chance(0.08)) assistant.push({ type: "text", text: words(rng, 5) });
    out.push({ role: "assistant", content: assistant });
    if (systemTurns && rng.chance(systemTurns)) out.push({ role: "system", content: "<system-reminder>" + words(rng, 12) + "</system-reminder>" });
    // Sometimes the result never came back (fixMissingToolResponses).
    if (rng.chance(0.04)) continue;
    const results = ids.map((id) => {
      const content = images && rng.chance(images)
        ? [{ type: "text", text: code(rng, rng.int(2, 12)) }, { type: "image", source: { type: "base64", media_type: "image/png", data: imageData(rng) } }]
        : rng.chance(0.5) ? code(rng, rng.int(1, 30)) : [{ type: "text", text: code(rng, rng.int(1, 30)) }];
      const block = { type: "tool_result", tool_use_id: id === null ? "missing" : id, content };
      if (rng.chance(errors)) block.is_error = true;
      return cc(block);
    });
    if (rng.chance(0.1)) results.push(cc({ type: "text", text: words(rng, 8) }));
    if (images && rng.chance(images / 2)) results.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData(rng) } });
    out.push({ role: "user", content: results });
  }
  out.push({ role: "user", content: [cc({ type: "text", text: words(rng, rng.int(5, 30)) })] });
  return out;
}

function ccSystem(rng, { cacheAll = true, blank = false } = {}) {
  const blocks = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=0.0.0; cc_entrypoint=cli;" },
    { type: "text", text: "You are a coding assistant working in a synthetic test repository." },
    { type: "text", text: words(rng, 120) },
  ];
  if (blank) blocks.splice(1, 0, { type: "text", text: "   " });
  for (const b of blocks) if (cacheAll) b.cache_control = { type: "ephemeral" };
  return blocks;
}

// ---- Connections ------------------------------------------------------------

const NODE_ID = "openai-compatible-chat-5f0c1d2e-0000-4000-8000-00000000c1a0";
const BASE = "https://gateway.example.test/v1";
const CC_HEADERS = { "user-agent": "claude-cli/2.1.258 (external, cli)", "x-app": "cli", "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27", "anthropic-version": "2023-06-01", accept: "application/json", "content-type": "application/json" };
const SDK_HEADERS = { "user-agent": "synthetic-sdk/1.0", "anthropic-version": "2023-06-01", "content-type": "application/json" };

function apiKeyFor(name) {
  return `sk-synthetic-${name.replace(/[^a-z0-9]/gi, "").slice(0, 24)}-0000`;
}

function node(model, extra = {}) {
  return { apiType: "chat", baseUrl: BASE, modelRoutes: { [model.replace(/\([^()]+\)\s*$/, "").trim()]: "anthropic" }, ...extra };
}

function ccBody(rng, model, opts = {}) {
  const tools = opts.tools ?? toolSet(rng, opts.toolCount ?? (SMALL ? rng.int(12, 16) : rng.int(12, 48)), { mcp: opts.mcp, numbers: opts.numbers, customEvery: opts.customEvery, cacheAll: opts.cacheAll });
  const toolNames = tools.map((t) => t.name);
  const body = {
    model: opts.clientModel ?? `combo-${rng.int(1, 9)}`,
    max_tokens: opts.maxTokens ?? 32000,
    // `stream: undefined` in opts leaves the field out (the writer skips undefined).
    stream: "stream" in opts ? opts.stream : true,
  };
  if (opts.thinking !== null) body.thinking = opts.thinking ?? { type: "enabled", budget_tokens: 31999 };
  body.metadata = { user_id: "user_" + rng.id("", 32) + "_account__session_" + rng.id("", 8) };
  body.system = opts.system ?? ccSystem(rng, { cacheAll: opts.cacheAll ?? true, blank: opts.blankSystem });
  body.tools = tools;
  body.messages = opts.messagesList ?? conversation(rng, { toolNames, ...opts });
  for (const [k, v] of Object.entries(opts.extra || {})) body[k] = v;
  return body;
}

// ---- Scenarios --------------------------------------------------------------

// Models across every thinking-capability family the tables give (capabilities.js).
export const THINKING_MODELS = [
  "claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5",
  "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-5-5", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1",
  "claude-3-5-sonnet-20241022", "claude-mythos-5-1", "gpt-5.4", "glm-5.2", "glm-4.6v", "deepseek-v4-flash", "kimi-k2.7",
  "qwen3-max", "minimax-m3", "gemini-2.5-pro", "gemini-3-pro", "custom-model-x", "hy3-preview", "step-3",
];
const SUFFIXES = ["", "(high)", "(none)", "(8192)", "(auto)", "(ultra)", "(max)", "(minimal)", "(xhigh)", "(low)", "(off)"];
const INTENTS = [
  null,
  { type: "enabled", budget_tokens: 31999 },
  { type: "enabled", budget_tokens: 2048 },
  { type: "enabled" },
  { type: "adaptive" },
  { type: "adaptive", display: "summarized" },
  { type: "adaptive", display: "updates" },
  { type: "disabled" },
];

function scenario(name, fn) {
  return { name, fn };
}

const SCENARIOS = [
  scenario("cc-basic", (rng, i) => {
    const model = rng.pick(["claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-5-5"]);
    // The first one carries the most tools Claude Code sends with MCP servers on.
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { messages: rng.int(50, 120), toolCount: i === 0 ? 48 : undefined }) };
  }),
  scenario("cc-cache-everywhere", (rng) => {
    const model = "claude-opus-4-8";
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { messages: rng.int(50, 90), cacheEverywhere: true, cacheAll: true }) };
  }),
  scenario("cc-defer-loading-tail", (rng) => {
    const model = "claude-sonnet-4-6";
    const tools = toolSet(rng, 20, {});
    for (const t of tools.slice(-4)) t.defer_loading = true;
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { tools, messages: 50 }) };
  }),
  scenario("cc-images-tool-errors", (rng, i) => {
    const model = rng.pick(["claude-opus-4-8", "glm-5.2", "claude-3-5-sonnet-20241022"]);
    const body = ccBody(rng, model, { messages: rng.int(50, 80), images: 0.3, errors: 0.4 });
    body.messages[0].content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageData(rng) } });
    body.messages[0].content.push({ type: "image", source: { type: "url", url: "https://images.example.test/a.png" } });
    body.messages[0].content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0" + rng.id("", 40) } });
    // The synced catalog can turn a modality on (documents for the Claude models, images for GLM).
    const catalog = i % 2 === 1 ? { modalities: { [model]: { pdf: true, vision: true } } } : null;
    return { model, headers: CC_HEADERS, body, catalog };
  }),
  scenario("cc-dedupe", (rng) => {
    const model = "claude-opus-4-8";
    const mcp = rng.pick([
      ["mcp__exa__web_search_exa", "mcp__workspace__web_fetch"],
      ["mcp__tavily__tavily_search"],
      ["mcp__browsermcp__navigate", "mcp__Claude_in_Chrome__click", "mcp__Claude_in_Chrome__read_page"],
      ["mcp__exa__web_search_exa", "mcp__browsermcp__click", "mcp__Claude_in_Chrome__click"],
    ]);
    const headers = rng.chance(0.3) ? SDK_HEADERS : CC_HEADERS;
    return { model, headers, body: ccBody(rng, model, { mcp, toolCount: rng.int(16, 30), messages: 50 }) };
  }),
  scenario("custom-tools", (rng) => {
    const model = "claude-opus-4-8";
    const tools = toolSet(rng, 14, { customEvery: 3 });
    tools.push({ type: "custom", name: "no_schema_custom", description: "dropped: custom without input_schema" });
    tools.push({ name: "untyped_no_schema", description: "kept, gets type custom" });
    tools.push({ type: "function", function: { name: "openai_style", description: "folded", parameters: { type: "object", properties: { q: { type: "string" } } } } });
    tools.push({ type: "function", function: { name: "openai_no_desc", parameters: { type: "object" } } });
    tools.push({ type: "bash_20250124", name: "bash" });
    tools.push({ type: "text_editor_20250728", name: "str_replace_based_edit_tool" });
    tools.push({ name: "array_type", input_schema: { type: ["object", "null"], properties: { a: { type: "string" } } } });
    tools.push({ name: "missing_type", input_schema: { properties: { a: { type: "string" } }, required: ["a"] } });
    tools.push({ name: "string_schema", input_schema: "not a schema" });
    tools.push({ name: "null_schema", input_schema: null });
    tools.push({ name: "nested_anyof", input_schema: { type: "object", properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } } } });
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { tools, messages: 50 }) };
  }),
  scenario("only-builtin-tools", (rng) => {
    const model = "claude-sonnet-4-6";
    const tools = [{ type: "bash_20250124", name: "bash" }, { type: "computer_20250124", name: "computer", display_width_px: 1024, display_height_px: 768 }];
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { tools, messages: 50, extra: { tool_choice: { type: "any" } } }) };
  }),
  scenario("tool-choice", (rng) => {
    const model = rng.pick(["claude-opus-5-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-opus-5", "glm-5.2"]);
    const choice = rng.pick([{ type: "any" }, { type: "tool", name: "Read" }, { type: "any", disable_parallel_tool_use: true }, { type: "auto" }, { type: "none" }, { type: "tool", name: "Read", disable_parallel_tool_use: false }]);
    const thinking = rng.pick([null, { type: "enabled", budget_tokens: 4096 }, { type: "adaptive" }, { type: "disabled" }]);
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { messages: 50, thinking, extra: { tool_choice: choice } }) };
  }),
  scenario("thinking-matrix", (rng, i) => {
    const base = THINKING_MODELS[i % THINKING_MODELS.length];
    // Suffix and intent drawn on their own, so no model is tied to a subset of
    // either (the large corpus also runs the full products below).
    const model = base + (i < THINKING_MODELS.length ? "" : rng.pick(SUFFIXES));
    const thinking = rng.pick(INTENTS);
    const extra = {};
    if (rng.chance(0.3)) extra.output_config = { effort: rng.pick(["low", "medium", "high", "max", "none", "auto", "xhigh"]) };
    if (rng.chance(0.15)) extra.reasoning_effort = rng.pick(["low", "high", "none"]);
    if (rng.chance(0.1)) extra.output_config = { format: { type: "json_schema", schema: { type: "object" } }, ...(rng.chance(0.5) ? { effort: "high" } : {}) };
    const providerThinking = rng.chance(0.25) ? { mode: rng.pick(["on", "off", "high", "none", "low", "auto"]) } : null;
    const messages = SMALL ? rng.int(6, 14) : rng.int(50, 70);
    const body = ccBody(rng, model, { messages, thinking, extra, toolCount: SMALL ? rng.int(3, 8) : undefined, maxTokens: rng.pick([1024, 16000, 32000, 64000, 128000, 200000]) });
    // Sometimes the turn ends on an assistant tool_use (normalizeThinkingConfig drops thinking).
    if (rng.chance(0.15)) body.messages.pop();
    return { model, headers: rng.chance(0.8) ? CC_HEADERS : SDK_HEADERS, body, providerThinking };
  }),
  scenario("max-tokens", (rng) => {
    const model = rng.pick(["claude-opus-4-8", "custom-model-x", "claude-sonnet-4-5", "claude-opus-4-6"]);
    const budget = rng.pick([128000, 64000, 63999, 100000, 1023]);
    const maxTokens = rng.pick([200000, 128000, 64000, 50000, 8000, raw("64000.0"), raw("1.28e5")]);
    const catalog = rng.chance(0.4) ? { limits: { [`${NODE_ID} ${model}`]: { contextWindow: 500000, maxOutput: rng.pick([32000, 100000, 300000]) } } } : null;
    return { model, headers: CC_HEADERS, catalog, body: ccBody(rng, model, { messages: 50, maxTokens, thinking: { type: "enabled", budget_tokens: budget } }) };
  }),
  scenario("empty-blocks", (rng) => {
    const model = rng.pick(["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"]);
    const body = ccBody(rng, model, { messages: 50, emptyBlocks: 0.3, blankSystem: true });
    body.messages.splice(3, 0, { role: "user", content: "" }, { role: "user", content: [] }, { role: "user", content: [{ type: "text", text: "  " }] }, { role: "user", content: "   \n" });
    body.messages.splice(9, 0, { role: "assistant", content: [{ type: "text", text: "" }] });
    // Consecutive same-role turns get merged, tool_results first.
    body.messages.splice(12, 0, { role: "user", content: "a plain string turn" }, { role: "user", content: [{ type: "text", text: words(rng, 4) }] });
    if (rng.chance(0.5)) body.messages.push({ role: "assistant", content: rng.pick(["", [], [{ type: "text", text: "" }], [{ type: "text", text: "Prefill" }]]) });
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("broken-ids", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: rng.int(50, 70), brokenIds: 0.4 });
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("system-turns", (rng) => {
    const model = rng.pick(["claude-opus-4-8", "claude-sonnet-4-6"]);
    const body = ccBody(rng, model, { messages: 60, systemTurns: 0.25 });
    body.messages.push({ role: "system", content: [{ type: "text", text: "<system-reminder>late</system-reminder>" }] });
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("params", (rng) => {
    const model = rng.pick(["claude-opus-4-8", "claude-opus-4-8[1m]", "glm-5.2", "claude-sonnet-4-6"]);
    const extra = {
      temperature: raw(rng.pick(["1.0", "0.7", "0", "1"])),
      top_p: raw("0.90"),
      top_k: 40,
      speed: "fast",
      service_tier: "auto",
      stop_sequences: ["\n\nHuman:", "END"],
      context_management: { edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 100000 } }] },
    };
    if (rng.chance(0.5)) extra.safeguards = { mode: "auto", rules: ["allow read"] };
    const clientModel = rng.chance(0.5) ? `combo-a[1m]` : `combo-b`;
    const keyHasBudget = rng.chance(0.5);
    const psd = rng.pick([{}, { droppedBetas: ["context-management-2025-06-27"] }, { stripBeta: true }, { droppedBetas: ["interleaved-thinking-2025-05-14"] }]);
    const headers = { ...CC_HEADERS };
    if (rng.chance(0.5)) headers["anthropic-beta"] += ",dangerous-tool-use-2026-09-03";
    return { model: model.replace("[1m]", ""), headers, keyHasBudget, psd, body: ccBody(rng, model, { messages: 50, extra, clientModel }) };
  }),
  scenario("official-host", (rng) => {
    const model = "claude-opus-4-8";
    const extra = { safeguards: { mode: "auto" }, context_management: { edits: [] } };
    const headers = { ...CC_HEADERS, "anthropic-beta": CC_HEADERS["anthropic-beta"] + ",dangerous-tool-use-2026-09-03,inline-tools-2026-09-15" };
    return { model, headers, psd: { baseUrl: "https://api.anthropic.com/v1" }, body: ccBody(rng, model, { messages: 50, extra }) };
  }),
  scenario("endpoint-overrides", (rng, i) => {
    const model = rng.pick(["claude-opus-4-8", "claude-sonnet-4-6"]);
    const variants = [
      { overrides: { models: "claude-opus-4-8 => vendor-opus\nclaude-sonnet-4-6 → vendor-sonnet", drop: "metadata, top_k" } },
      { overrides: { body: JSON.stringify({ metadata: { user_id: "fixed" }, extra_field: { a: 1.5, b: [1, 2] }, top_k: null }) } },
      { overrides: { body: "{\"thinking\":{\"type\":\"disabled\"},\"temperature\":1.0,\"n\":1e2}", stream: "always" } },
      { overrides: { stream: "never" } },
      { overrides: { headers: "x-custom: one\n-anthropic-version\nX-Trace-Id: 42\nanthropic-beta: extra-flag-1" } },
      { authHeader: rng.pick(["bearer", "x-api-key", "api-key", "both"]) },
      { mimic: "claude-code" },
      { mimic: "codex" },
      { mimic: "custom", customHeaders: "user-agent: custom-agent/1.0\nanthropic-beta: custom-beta-1" },
      { overrides: { query: "api-version=2025-01-01&mode=a b" } },
      { overrides: { path: "/v2/messages" } },
      { overrides: {} },
      { stripReasoning: true, blockForeignTools: true },
      { droppedBetas: ["claude-code-20250219", "interleaved-thinking-2025-05-14"], overrides: { headers: "anthropic-beta: interleaved-thinking-2025-05-14,new-flag" } },
      { stripBeta: true, mimic: "claude-code" },
      { overrides: { headers: "content-type: text/plain\nno colon here\nbad name: x\n: empty\n-x-api-key\n- \nAccept: */*" } },
      { authHeader: "api-key", mimic: "gemini-cli" },
      { overrides: { models: "claude-opus-4-8=>a=>b\nclaude-sonnet-4-6=>plain\n__proto__ => x\nnot a rename" } },
      { overrides: { body: "{not json" } },
      { overrides: { body: "{\"__proto__\":{\"x\":1},\"constructor\":2,\"metadata\":null,\"nested\":{\"a\":{\"b\":1}}}", stream: "always" }, clientStream: false },
      { overrides: { body: "﻿{\"extra\":1}" } },
      { overrides: { drop: "model" }, toolChoice: { type: "any" } },
    ];
    const { clientStream, toolChoice, ...psd } = variants[i % variants.length];
    const opts = { messages: SMALL ? 10 : 50, toolCount: SMALL ? 6 : undefined };
    if (clientStream !== undefined) opts.stream = clientStream;
    if (toolChoice) opts.extra = { tool_choice: toolChoice };
    return { model, headers: CC_HEADERS, psd, body: ccBody(rng, model, opts) };
  }),
  scenario("numbers-and-keys", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: 50, numbers: true });
    body.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_numbers", name: "Read", input: pairs([["__proto__", { polluted: true }], ["b", 1], ["a", 2], ["b", 3], ["01", "x"], ["1", raw("1.0E2")], ["4294967295", "not an index"], ["4294967294", "an index"]]) }] });
    body.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_numbers", content: [{ type: "text", text: esc("caf\\u00e9 \\/ \\ud83d\\ude00 lone \\ud800 \\u2028 \\u0001 tab\\t \\\"q\\\" \\u001f \\b\\f") }] }] });
    return { model, headers: CC_HEADERS, body, style: rng.pick(["compact", "pretty", "loose"]) };
  }),
  scenario("limit-hold-banner", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: 50, system: rng.pick([undefined, "a plain string system prompt", ""]) });
    if (body.system === undefined) body.system = ccSystem(rng);
    body.messages.splice(2, 0, { role: "assistant", content: [{ type: "text", text: "[10router:limit-hold] waiting for the rate limit to clear" }] }, { role: "user", content: "ok" });
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("oauth-token-key", (rng, i) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: 50, system: rng.pick([undefined, "string system", [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }]]) });
    if (body.system === undefined) delete body.system;
    const token = "sk-ant-oat01-synthetic-not-a-real-token-0000";
    // As the key, as an access token beside a plain key (translateRequest reads
    // the token first, the headers the key), and as the only credential.
    const creds = [{ apiKey: token }, { apiKey: "sk-synthetic-plain-0000", accessToken: token }, { apiKey: null, accessToken: token }][i % 3];
    return { model, headers: CC_HEADERS, body, ...creds };
  }),
  scenario("stream-shapes", (rng, i) => {
    const model = "claude-opus-4-8";
    const stream = [true, false, undefined][i % 3];
    const accept = ["application/json", "text/event-stream", "*/*", "application/json, text/event-stream"][Math.floor(i / 3) % 4];
    const ua = i % 5 === 4 ? "deepseek-tui/0.1" : SDK_HEADERS["user-agent"];
    const headers = { ...SDK_HEADERS, "user-agent": ua, accept };
    return { model, headers, body: ccBody(rng, model, { messages: SMALL ? 12 : 50, stream }) };
  }),
  scenario("base-urls", (rng, i) => {
    const model = "claude-sonnet-4-6";
    const bases = [
      "https://gateway.example.test/v1/", "https://gateway.example.test/v1/messages", "https://gateway.example.test/v1/chat/completions",
      "https://gateway.example.test/v1?api-version=2024-10-01", "https://GATEWAY.example.test:443/v1", "https://gateway.example.test:8443/api/v1",
      "http://gateway.example.test:8080/v1", "https://gateway.example.test/v1//", "https://gateway.example.test/v1?b=2&a=1&b=3",
    ];
    const baseUrl = bases[i % bases.length];
    const query = i % 2 === 0 ? { overrides: { query: rng.pick(["b=9", "x=1&y=a%20b", "mode=fast+slow&b=1"]) } } : {};
    return { model, headers: CC_HEADERS, psd: { baseUrl, ...query }, body: ccBody(rng, model, { messages: SMALL ? 8 : 50, toolCount: SMALL ? 4 : undefined }) };
  }),
  scenario("provider-thinking", (rng, i) => {
    const model = ["claude-opus-4-8", "claude-sonnet-4-5", "glm-5.2", "gpt-5.4"][i % 4];
    const mode = ["on", "off", "high", "none", "low", "auto"][Math.floor(i / 4) % 6];
    const thinking = i % 2 === 0 ? null : { type: "enabled", budget_tokens: 4096 };
    const extra = i % 3 === 0 ? { reasoning_effort: "medium" } : {};
    return { model, headers: CC_HEADERS, providerThinking: { mode }, body: ccBody(rng, model, { messages: SMALL ? 8 : 50, toolCount: SMALL ? 4 : undefined, thinking, extra }) };
  }),
  scenario("prefill-repair", (rng, i) => {
    const model = ["claude-opus-5", "claude-opus-5-5", "claude-opus-4-8", "claude-opus-5-thinking"][i % 4];
    const body = ccBody(rng, model, { messages: SMALL ? 10 : 50, toolCount: SMALL ? 4 : undefined });
    const last = i % 2 === 0
      ? { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_dangling_1", name: "Read", input: { path: "/a" } }, { type: "tool_use", id: "toolu_dangling_2", name: "Grep", input: {} }] }
      : { role: "assistant", content: [{ type: "text", text: "Partial answer" }] };
    body.messages.push(last);
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("odd-tool-calls", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: SMALL ? 8 : 50, toolCount: SMALL ? 4 : undefined });
    // OpenAI-shaped tool_calls inside a Claude body: an array entry Node sets an
    // id on (and JSON.stringify ignores), ids that need repair.
    body.messages.splice(2, 0, { role: "assistant", content: "calling", tool_calls: [[], { id: "bad id!", function: { name: "Read", arguments: { path: "/x" } } }, { function: { name: "a b" } }] });
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("translator-fields", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: 50, extra: { _customToolNames: ["x"], _toolNamespaces: { a: { name: "a" } } } });
    body.messages[1].encrypted_content = "opaque";
    body.messages[1].reasoning_encrypted_content = "opaque";
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("reasoning-inject-models", (rng) => {
    const model = rng.pick(["deepseek-v4-flash", "kimi-k2.7"]);
    const body = ccBody(rng, model, { messages: 50 });
    body.messages[1].reasoning_content = rng.pick(["", "kept"]);
    // Kimi's rule only touches assistant turns with tool_calls; a single-turn
    // history keeps its message objects (fixToolUseOrdering rebuilds longer ones).
    if (rng.chance(0.5)) body.messages = [{ role: "assistant", content: "x", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: "{}" } }] }];
    return { model, headers: CC_HEADERS, body };
  }),
  scenario("invalid-utf8", (rng) => {
    const model = "claude-opus-4-8";
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { messages: 50 }), invalidUtf8: true };
  }),
  // Shapes the Go port deliberately hands back to Node (the fallback rule:
  // when in doubt, proxy). Each says why.
  scenario("decline-web-search", (rng) => {
    const model = "claude-opus-4-8";
    const tools = [...toolSet(rng, 12, {}), { type: "web_search_20250305", name: "web_search", max_uses: 5 }];
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { tools, messages: 50 }), expectDecline: "web search tool" };
  }),
  scenario("decline-top-level-combinator", (rng) => {
    const model = "claude-opus-4-8";
    const tools = [...toolSet(rng, 12, {}), { name: "union", input_schema: { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] } }];
    return { model, headers: CC_HEADERS, body: ccBody(rng, model, { tools, messages: 50 }), expectDecline: "tool input_schema needs flattening" };
  }),
  scenario("decline-tool-change", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: 50 });
    body.messages.splice(4, 0, { role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "Read" } }] });
    return { model, headers: CC_HEADERS, body, expectDecline: "mid-conversation tool change" };
  }),
  scenario("decline-response-format", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: 50, extra: { response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } } });
    return { model, headers: CC_HEADERS, body, expectDecline: "json_schema response_format" };
  }),
  scenario("decline-null-block", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: 50 });
    body.messages[2].content.push(null);
    return { model, headers: CC_HEADERS, body, expectDecline: "a content block that isn't an object" };
  }),
  scenario("decline-primitive-tool-call", (rng) => {
    const model = "claude-opus-4-8";
    const body = ccBody(rng, model, { messages: SMALL ? 8 : 50, toolCount: SMALL ? 4 : undefined });
    body.messages.splice(2, 0, { role: "assistant", content: "x", tool_calls: ["not an object"] });
    return { model, headers: CC_HEADERS, body, expectDecline: "a tool call that isn't an object" };
  }),
  scenario("decline-prototype-effort", (rng) => {
    const model = "gemini-3-pro";
    const body = ccBody(rng, model, { messages: SMALL ? 8 : 50, toolCount: SMALL ? 4 : undefined, thinking: null, extra: { reasoning_effort: "constructor" } });
    return { model, headers: CC_HEADERS, body, expectDecline: "Object.prototype" };
  }),
  scenario("decline-blocked-connection", (rng) => {
    const model = "claude-opus-4-8";
    return { model, headers: CC_HEADERS, psd: { blockedReason: "proxy pool unavailable" }, body: ccBody(rng, model, { messages: SMALL ? 8 : 50, toolCount: SMALL ? 4 : undefined }), expectDecline: "blocked" };
  }),
  scenario("decline-non-ascii-header", (rng) => {
    const model = "claude-opus-4-8";
    return { model, headers: CC_HEADERS, psd: { overrides: { headers: "x-tag: café" } }, body: ccBody(rng, model, { messages: SMALL ? 8 : 50, toolCount: SMALL ? 4 : undefined }), expectDecline: "non-ASCII header" };
  }),
];

const smallCount = {
  "thinking-matrix": 40, "endpoint-overrides": 22, "tool-choice": 6, "max-tokens": 6, "cc-basic": 3, "empty-blocks": 4, params: 6,
  "stream-shapes": 12, "cc-dedupe": 4, "cc-images-tool-errors": 4, "broken-ids": 2, "numbers-and-keys": 3, "limit-hold-banner": 3,
  "oauth-token-key": 3, "base-urls": 9, "provider-thinking": 12, "prefill-repair": 4,
};

function toFixture(name, spec, seed) {
  const style = spec.style || "compact";
  const text = writeJson(spec.body, style);
  if (!text.isWellFormed()) throw new Error(`${name}: body text has a lone surrogate`);
  const request = { headers: spec.headers };
  if (spec.invalidUtf8) {
    // Raw bytes Node's request.text() turns into U+FFFD: a lone continuation
    // byte, a truncated sequence, an overlong form and a stray 0xFF.
    const marker = "INVALID_UTF8_HERE";
    const withMarker = text.replace("</system-reminder>", `${marker}</system-reminder>`);
    const [head, tail] = withMarker.split(marker);
    request.bodyBase64 = Buffer.concat([Buffer.from(head), Buffer.from([0x80, 0xe2, 0x82, 0x41, 0xc0, 0xaf, 0xff, 0xf0, 0x9f, 0x98]), Buffer.from(tail)]).toString("base64");
  } else {
    request.body = text;
  }
  const model = spec.model;
  const psd = { ...node(model), ...(spec.psd || {}) };
  if (spec.psd?.baseUrl) psd.baseUrl = spec.psd.baseUrl;
  const fixture = {
    name,
    seed,
    inputs: {
      provider: NODE_ID,
      model,
      apiKey: spec.apiKey === null ? null : spec.apiKey || apiKeyFor(name),
      ...(spec.accessToken ? { accessToken: spec.accessToken } : {}),
      providerSpecificData: psd,
      providerThinking: spec.providerThinking || null,
      keyHasBudget: !!spec.keyHasBudget,
      catalog: spec.catalog || null,
    },
    request,
  };
  if (spec.expectDecline) fixture.expectDecline = spec.expectDecline;
  return fixture;
}

/**
 * The corpus. `large` adds long histories (1,000+ messages, 48 tools) and
 * more draws of every scenario; CI generates it, the repo keeps the small one.
 */
export function buildCorpus({ large = false } = {}) {
  SCALE = large ? 1 : 0.12;
  SMALL = !large;
  const out = [];
  SCENARIOS.forEach(({ name, fn }, s) => {
    const n = large ? (smallCount[name] || 1) * 4 : (smallCount[name] || 1);
    for (let i = 0; i < n; i++) {
      const seed = (large ? 1_000_003 : 17) * (s + 1) + i * 7919;
      const rng = new Rng(seed);
      out.push(toFixture(`${name}-${String(i).padStart(3, "0")}`, fn(rng, i), seed));
    }
  });
  if (large) {
    // Every model with every thinking intent, then with every suffix.
    THINKING_MODELS.forEach((model, m) => {
      INTENTS.forEach((thinking, t) => {
        const rng = new Rng(77_000 + m * 100 + t);
        const body = ccBody(rng, model, { messages: 6, toolCount: 3, thinking, maxTokens: rng.pick([4096, 64000, 200000]) });
        out.push(toFixture(`thinking-product-${model}-${t}`, { model, headers: CC_HEADERS, body }, 77_000 + m * 100 + t));
      });
      SUFFIXES.slice(1).forEach((suffix, s) => {
        const rng = new Rng(88_000 + m * 100 + s);
        const body = ccBody(rng, model + suffix, { messages: 6, toolCount: 3, thinking: rng.pick(INTENTS) });
        out.push(toFixture(`suffix-product-${model}-${s}`, { model: model + suffix, headers: CC_HEADERS, body }, 88_000 + m * 100 + s));
      });
    });
    for (let i = 0; i < 12; i++) {
      const seed = 424242 + i;
      const rng = new Rng(seed);
      const model = rng.pick(["claude-opus-4-8", "claude-sonnet-4-6", "claude-opus-5-5", "claude-haiku-4-5"]);
      const body = ccBody(rng, model, { messages: rng.int(1000, 1400), toolCount: 48, images: 0.05, cacheEverywhere: i % 3 === 0, brokenIds: i % 4 === 0 ? 0.05 : 0, numbers: i % 2 === 0, emptyBlocks: 0.05 });
      out.push(toFixture(`large-${String(i).padStart(3, "0")}`, { model, headers: CC_HEADERS, body, style: i % 5 === 0 ? "pretty" : "compact" }, seed));
    }
  }
  return out;
}
