// Advanced / Ultra advanced settings of a user-added endpoint, applied to the
// real upstream request. Only openai-compatible-* and anthropic-compatible-*
// nodes carry them (saved on the node, copied onto each key's
// providerSpecificData; see src/shared/utils/nodeQuirks.ts).
//
// installEndpointOverrides(DefaultExecutor) wraps the executor once:
//   buildUrl         path override (primary path only) + query params
//   buildHeaders     auth header style, client identity, raw header lines, beta rules
//   transformRequest model renames, streaming, dropped fields, JSON merge (applied last)
//   execute          timeout, retries, per-endpoint proxy; reply filters
// streamOverride() tells chatCore how the upstream will answer.
import {
  applyAuthHeader, applyBodyOverrides, applyHeaderOps, applyUrlOverrides, filterBeta, getHeader, parseHeaderLines,
} from "@/shared/utils/endpointOverrides.js";
import { mimicHeaderText } from "@/shared/utils/nodeQuirks.js";
import type { NodeQuirks, RawOverrides } from "@/shared/utils/nodeQuirks.js";

type Headers_ = Record<string, string>;
interface Credentials {
  apiKey?: string;
  accessToken?: string;
  providerSpecificData?: NodeQuirks & Record<string, unknown>;
  runtimeTransport?: { compatibleRoute?: string; format?: string } | null;
}
interface ExecuteArgs {
  model: string;
  body: unknown;
  stream: boolean;
  credentials: Credentials;
  proxyOptions?: Record<string, unknown> | null;
  log?: { warn?: (tag: string, msg: string) => void } | null;
  [k: string]: unknown;
}
interface ExecuteResult {
  response: Response;
  url?: string;
  headers?: Headers_;
  transformedBody?: unknown;
  [k: string]: unknown;
}
interface ExecutorLike {
  provider: string;
  config: Record<string, unknown> & { retry?: Record<string, unknown>; timeoutMs?: number };
  onMessagesPath(credentials: Credentials): boolean;
  buildUrl(model: string, stream: boolean, urlIndex?: number, credentials?: Credentials | null): string;
  buildHeaders(credentials: Credentials, stream?: boolean, url?: string, model?: string): Headers_;
  transformRequest(model: string, body: unknown, stream: boolean, credentials: Credentials): unknown;
  execute(args: ExecuteArgs): Promise<ExecuteResult>;
}
type ExecutorClass = { prototype: ExecutorLike };

const COMPATIBLE_RE = /^(openai|anthropic)-compatible-/;
const RETRY_STATUSES = [429, 500, 502, 503, 504];
const RETRY_DELAY_MS = 1000;

export function isCompatibleProvider(provider: unknown): boolean {
  return typeof provider === "string" && COMPATIBLE_RE.test(provider);
}

// The settings this request should honour, or null for a provider that has none.
export function endpointSettings(provider: unknown, credentials: Credentials | null | undefined): NodeQuirks | null {
  if (!isCompatibleProvider(provider)) return null;
  const psd = credentials?.providerSpecificData;
  if (!psd) return null;
  const has = psd.overrides || psd.authHeader || (psd.mimic && psd.mimic !== "none") || psd.blockForeignTools || psd.stripReasoning;
  return has ? psd : null;
}

// "Streaming: Always" / "Never", or null. chatCore treats "always" like a
// forceStream provider (an SSE reply is converted back for JSON clients) and
// "never" as a JSON upstream (replayed as SSE for streaming clients).
export function streamOverride(provider: unknown, credentials: Credentials | null | undefined): "always" | "never" | null {
  const s = endpointSettings(provider, credentials)?.overrides?.stream;
  return s === "always" || s === "never" ? s : null;
}

// The headers after the user's settings. Auth first (so "-authorization" in the
// raw lines can still remove it), then identity, raw lines, then beta rules.
export function applyEndpointHeaders(headers: Headers_, q: NodeQuirks, credentials: Credentials, { messagesPath }: { messagesPath: boolean }): Headers_ {
  const key = credentials.apiKey || credentials.accessToken || "";
  if (q.authHeader) applyAuthHeader(headers, q.authHeader, key);
  let identity = parseHeaderLines(mimicHeaderText(q));
  // A preset's beta flags are for Messages; OpenAI paths never see anthropic-beta from us.
  if (!messagesPath && q.mimic !== "custom") identity = identity.filter((o) => o.name.toLowerCase() !== "anthropic-beta");
  // A preset's beta flags join the ones already going out (the client's own).
  const beta = identity.find((o) => o.op === "set" && o.name.toLowerCase() === "anthropic-beta");
  const current = getHeader(headers, "anthropic-beta");
  if (beta && beta.op === "set" && current && q.mimic !== "custom") beta.value = [...new Set([...current.split(","), ...beta.value.split(",")].map((f) => f.trim()).filter(Boolean))].join(",");
  applyHeaderOps(headers, identity);
  applyHeaderOps(headers, parseHeaderLines(q.overrides?.headers));
  if (messagesPath) filterBeta(headers, { dropped: q.droppedBetas, stripAll: q.stripBeta === true });
  return headers;
}

// Connection settings: a view of the executor with its own timeout / retry
// table, and proxy options for this endpoint only.
function connectionOverrides(ex: ExecutorLike, o: RawOverrides | undefined, args: ExecuteArgs): { ex: ExecutorLike; args: ExecuteArgs } {
  if (!o) return { ex, args };
  let next = ex;
  if (o.timeout || o.retries !== undefined) {
    const config = { ...ex.config };
    if (o.timeout) config.timeoutMs = Math.round(Number(o.timeout) * 1000);
    if (o.retries !== undefined) {
      const n = Number(o.retries);
      config.retry = { ...(ex.config.retry || {}), ...Object.fromEntries(RETRY_STATUSES.map((s) => [s, { attempts: n, delayMs: RETRY_DELAY_MS }])) };
    }
    next = Object.create(ex) as ExecutorLike;
    next.config = config;
  }
  let a = args;
  if (o.proxy) a = { ...a, proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: o.proxy, connectionNoProxy: "", strictProxy: true } };
  if (o.stream === "never") a = { ...a, stream: false };
  if (o.stream === "always") a = { ...a, stream: true };
  return { ex: next, args: a };
}

let installed = false;
// Wrap the executor's request building once. Providers without settings take
// the original path untouched.
export function installEndpointOverrides(Cls: ExecutorClass): void {
  if (installed) return;
  installed = true;
  const p = Cls.prototype;
  const { buildUrl, buildHeaders, transformRequest, execute } = p;

  p.buildUrl = function (this: ExecutorLike, model, stream, urlIndex = 0, credentials = null) {
    const url = buildUrl.call(this, model, stream, urlIndex, credentials);
    const o = endpointSettings(this.provider, credentials)?.overrides;
    // A two-path node's second API keeps its own path; the override is for the main one.
    return o ? applyUrlOverrides(url, o, { replacePath: !credentials?.runtimeTransport?.compatibleRoute }) : url;
  };

  p.buildHeaders = function (this: ExecutorLike, credentials, stream = true, url, model) {
    const headers = buildHeaders.call(this, credentials, stream, url, model);
    const q = endpointSettings(this.provider, credentials);
    return q ? applyEndpointHeaders(headers, q, credentials, { messagesPath: this.onMessagesPath(credentials) }) : headers;
  };

  p.transformRequest = function (this: ExecutorLike, model, body, stream, credentials) {
    const out = transformRequest.call(this, model, body, stream, credentials);
    const o = endpointSettings(this.provider, credentials)?.overrides;
    return o ? applyBodyOverrides(out, o) : out;
  };

  p.execute = async function (this: ExecutorLike, args) {
    const q = endpointSettings(this.provider, args?.credentials);
    if (!q) return execute.call(this, args);
    const { ex, args: a } = connectionOverrides(this, q.overrides, args);
    const result = await execute.call(ex, a);
    if (!result?.response?.ok || !(q.blockForeignTools || q.stripReasoning)) return result;
    const offered = offeredTools(result.transformedBody ?? a.body);
    const filter = makeReplyFilter({ blockForeignTools: !!q.blockForeignTools, stripReasoning: !!q.stripReasoning, offered });
    const response = filterResponse(result.response, filter, (n) => a.log?.warn?.("GUARD", `${this.provider}: dropped ${n} tool call${n === 1 ? "" : "s"} for tools the client never offered`));
    return { ...result, response };
  };
}

// ---- Reply filters ----------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

// Tool names the request offered, in any of the three shapes.
export function offeredTools(body: unknown): Set<string> {
  const names = new Set<string>();
  const tools = isObj(body) && Array.isArray(body.tools) ? body.tools : [];
  for (const t of tools) {
    if (!isObj(t)) continue;
    const fn = isObj(t.function) ? t.function : null;
    const name = fn?.name ?? t.name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

interface FilterOpts { blockForeignTools: boolean; stripReasoning: boolean; offered: Set<string> }
// One filter per reply. It sees each JSON event (SSE) or the whole JSON body,
// returns the (possibly edited) object, or null to drop the event.
export interface ReplyFilter {
  event(obj: Json): Json | null;
  whole(obj: Json): Json;
  dropped(): number;
}

// Renumbers indices so a client never sees a gap where a dropped block was.
class IndexMap {
  private dropped = new Set<number>();
  private kept = new Map<number, number>();
  private next = 0;
  drop(i: number) { this.dropped.add(i); }
  isDropped(i: unknown) { return typeof i === "number" && this.dropped.has(i); }
  map(i: unknown): unknown {
    if (typeof i !== "number") return i;
    if (!this.kept.has(i)) this.kept.set(i, this.next++);
    return this.kept.get(i);
  }
  get any() { return this.dropped.size > 0; }
  get keptCount() { return this.next; }
}

const REASONING_KEYS = ["reasoning_content", "reasoning", "reasoning_details", "thinking"];

export function makeReplyFilter({ blockForeignTools, stripReasoning, offered }: FilterOpts): ReplyFilter {
  let droppedTools = 0;
  const foreign = (name: unknown) => blockForeignTools && typeof name === "string" && !offered.has(name);
  // Chat Completions: tool_call index → kept/dropped, per choice.
  const chatCalls = new Map<number, IndexMap>();
  let chatKeptTools = 0;
  // Claude content blocks and Responses output items.
  const blocks = new IndexMap();
  const items = new IndexMap();
  let keptToolBlocks = 0;
  let droppedToolBlocks = 0;

  const dropClaudeBlock = (b: Json) =>
    (stripReasoning && (b.type === "thinking" || b.type === "redacted_thinking")) || (b.type === "tool_use" && foreign(b.name));
  const dropResponsesItem = (it: Json) =>
    (stripReasoning && it.type === "reasoning") || (it.type === "function_call" && foreign(it.name));

  const chatMessage = (m: Json, choiceIdx: number, isDelta: boolean) => {
    if (stripReasoning) for (const k of REASONING_KEYS) delete m[k];
    if (!Array.isArray(m.tool_calls)) return;
    const map = chatCalls.get(choiceIdx) || new IndexMap();
    chatCalls.set(choiceIdx, map);
    const kept: Json[] = [];
    m.tool_calls.forEach((tc: unknown, pos: number) => {
      if (!isObj(tc)) return;
      const idx = typeof tc.index === "number" ? tc.index : pos;
      const fn = isObj(tc.function) ? tc.function : {};
      if (fn.name !== undefined && foreign(fn.name) && !map.isDropped(idx)) { map.drop(idx); droppedTools++; }
      if (map.isDropped(idx)) return;
      if (isDelta || typeof tc.index === "number") tc.index = map.map(idx);
      else map.map(idx);
      kept.push(tc);
    });
    chatKeptTools = Math.max(chatKeptTools, map.keptCount);
    if (kept.length) m.tool_calls = kept;
    else delete m.tool_calls;
  };
  const chatFinish = (c: Json) => {
    if (c.finish_reason === "tool_calls" && chatKeptTools === 0 && [...chatCalls.values()].some((m) => m.any)) c.finish_reason = "stop";
  };

  const event = (obj: Json): Json | null => {
    // OpenAI Chat Completions chunk
    if (Array.isArray(obj.choices)) {
      for (const c of obj.choices) {
        if (!isObj(c)) continue;
        const idx = typeof c.index === "number" ? c.index : 0;
        if (isObj(c.delta)) chatMessage(c.delta, idx, true);
        if (isObj(c.message)) chatMessage(c.message, idx, false);
        chatFinish(c);
      }
      return obj;
    }
    const type = obj.type;
    if (typeof type !== "string") return obj;
    // Anthropic Messages stream
    if (type === "content_block_start" && isObj(obj.content_block)) {
      if (dropClaudeBlock(obj.content_block)) {
        blocks.drop(obj.index as number);
        if (obj.content_block.type === "tool_use") { droppedTools++; droppedToolBlocks++; }
        return null;
      }
      if (obj.content_block.type === "tool_use") keptToolBlocks++;
      obj.index = blocks.map(obj.index);
      return obj;
    }
    if (type === "content_block_delta" || type === "content_block_stop") {
      if (blocks.isDropped(obj.index)) return null;
      obj.index = blocks.map(obj.index);
      return obj;
    }
    if (type === "message_delta" && isObj(obj.delta) && obj.delta.stop_reason === "tool_use" && droppedToolBlocks && !keptToolBlocks) {
      obj.delta.stop_reason = "end_turn";
      return obj;
    }
    // OpenAI Responses stream
    if (type.startsWith("response.")) {
      if (isObj(obj.item) && (type === "response.output_item.added" || type === "response.output_item.done")) {
        if (type === "response.output_item.added" && dropResponsesItem(obj.item)) {
          items.drop(obj.output_index as number);
          if (obj.item.type === "function_call") droppedTools++;
        }
      }
      if ("output_index" in obj) {
        if (items.isDropped(obj.output_index)) return null;
        obj.output_index = items.map(obj.output_index);
      }
      if (isObj(obj.response) && Array.isArray(obj.response.output)) obj.response.output = obj.response.output.filter((it: unknown) => !(isObj(it) && dropResponsesItem(it)));
      return obj;
    }
    return obj;
  };

  const whole = (obj: Json): Json => {
    if (Array.isArray(obj.choices)) return event(obj) || obj;
    // Anthropic message
    if (Array.isArray(obj.content) && obj.type === "message") {
      const tools = (list: unknown[]) => list.filter((b) => isObj(b) && b.type === "tool_use").length;
      const toolsBefore = tools(obj.content);
      const kept = obj.content.filter((b: unknown) => !(isObj(b) && dropClaudeBlock(b)));
      obj.content = kept;
      const toolsAfter = tools(kept);
      droppedTools += toolsBefore - toolsAfter;
      if (obj.stop_reason === "tool_use" && toolsBefore && !toolsAfter) obj.stop_reason = "end_turn";
      return obj;
    }
    // Responses object
    if (Array.isArray(obj.output)) {
      const fns = (list: unknown[]) => list.filter((it) => isObj(it) && it.type === "function_call").length;
      const fnBefore = fns(obj.output);
      const kept = obj.output.filter((it: unknown) => !(isObj(it) && dropResponsesItem(it)));
      obj.output = kept;
      droppedTools += fnBefore - fns(kept);
      return obj;
    }
    return obj;
  };

  return { event, whole, dropped: () => droppedTools };
}

// Run an SSE text through the filter, one event at a time. Exported for tests.
export function filterSseEvent(raw: string, filter: ReplyFilter): string | null {
  const lines = raw.split("\n");
  const dataIdx = lines.findIndex((l) => l.startsWith("data:"));
  if (dataIdx === -1) return raw;
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
  let obj: unknown;
  try { obj = JSON.parse(data); } catch { return raw; } // [DONE] and friends
  if (!isObj(obj)) return raw;
  const out = filter.event(obj);
  if (!out) return null;
  const rest = lines.filter((l, i) => !l.startsWith("data:") || i === dataIdx);
  return rest.map((l) => (l.startsWith("data:") ? `data: ${JSON.stringify(out)}` : l)).join("\n");
}

export function filterResponse(res: Response, filter: ReplyFilter, onDropped?: (n: number) => void): Response {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const init = { status: res.status, statusText: res.statusText, headers };
  if (!res.body) return res;

  if (type.includes("text/event-stream")) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buf = "";
    const flushEvents = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
      buf = buf.replace(/\r\n/g, "\n");
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const out = filterSseEvent(raw, filter);
        if (out !== null) controller.enqueue(encoder.encode(`${out}\n\n`));
      }
      if (final && buf.trim()) {
        const out = filterSseEvent(buf, filter);
        if (out !== null) controller.enqueue(encoder.encode(`${out}\n\n`));
        buf = "";
      }
    };
    const stream = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { buf += decoder.decode(chunk, { stream: true }); flushEvents(controller, false); },
      flush(controller) { buf += decoder.decode(); flushEvents(controller, true); const n = filter.dropped(); if (n) onDropped?.(n); },
    }));
    return new Response(stream, init);
  }

  if (type.includes("json")) {
    const body = res.text().then((t) => {
      try {
        const obj: unknown = JSON.parse(t);
        if (!isObj(obj)) return t;
        const out = JSON.stringify(filter.whole(obj));
        const n = filter.dropped(); if (n) onDropped?.(n);
        return out;
      } catch { return t; }
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) { controller.enqueue(new TextEncoder().encode(await body)); controller.close(); },
    });
    return new Response(stream, init);
  }
  return res;
}
