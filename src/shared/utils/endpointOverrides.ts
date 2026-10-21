// Ultra advanced overrides and client identity, as pure functions. The runtime
// (open-sse/handlers/chatCore/endpointOverrides.ts) and the dashboard's
// "What gets sent" preview both use these, so the preview is what goes out.
// No node:* imports: the dashboard bundles this file.
import { mimicHeaderText, parseBodyOverride } from "./nodeQuirks.js";
import type { AuthHeader, NodeQuirks, RawOverrides, RouteProtocol } from "./nodeQuirks.js";

export type HeaderOp = { op: "set"; name: string; value: string } | { op: "remove"; name: string };

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// "name: value" sets, "-name" removes. Blank lines and malformed lines are skipped.
export function parseHeaderLines(textValue: string | undefined | null): HeaderOp[] {
  const ops: HeaderOp[] = [];
  for (const raw of String(textValue || "").split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("-")) {
      const name = l.slice(1).trim();
      if (HEADER_NAME_RE.test(name)) ops.push({ op: "remove", name });
      continue;
    }
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const name = l.slice(0, i).trim();
    const value = l.slice(i + 1).trim();
    if (HEADER_NAME_RE.test(name) && !/[\r\n\0]/.test(value)) ops.push({ op: "set", name, value });
  }
  return ops;
}

// Header maps here are plain objects with mixed-case keys ("Authorization",
// "x-api-key"); names match case-insensitively.
export function deleteHeader(headers: Record<string, string>, name: string): void {
  const n = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === n) delete headers[k];
}
export function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const n = name.toLowerCase();
  const k = Object.keys(headers).find((x) => x.toLowerCase() === n);
  return k === undefined ? undefined : headers[k];
}
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  deleteHeader(headers, name);
  headers[name] = value;
}
export function applyHeaderOps(headers: Record<string, string>, ops: HeaderOp[]): Record<string, string> {
  for (const o of ops) {
    if (o.op === "remove") deleteHeader(headers, o.name);
    else setHeader(headers, o.name, o.value);
  }
  return headers;
}

// Send the key the way the user picked. Leaves headers alone with no key.
export function applyAuthHeader(headers: Record<string, string>, mode: AuthHeader, key: string): Record<string, string> {
  if (!key) return headers;
  for (const h of ["authorization", "x-api-key", "api-key"]) deleteHeader(headers, h);
  if (mode === "bearer" || mode === "both") headers.Authorization = `Bearer ${key}`;
  if (mode === "x-api-key" || mode === "both") headers["x-api-key"] = key;
  if (mode === "api-key") headers["api-key"] = key;
  return headers;
}

// Drop learned (or all) beta flags from whatever anthropic-beta ended up set.
export function filterBeta(headers: Record<string, string>, { dropped = [], stripAll = false }: { dropped?: readonly string[]; stripAll?: boolean }): void {
  const v = getHeader(headers, "anthropic-beta");
  if (v === undefined) return;
  const drop = new Set(dropped);
  const kept = stripAll ? [] : v.split(",").map((s) => s.trim()).filter((s) => s && !drop.has(s));
  if (kept.length) setHeader(headers, "anthropic-beta", kept.join(","));
  else deleteHeader(headers, "anthropic-beta");
}

// Identity, then raw header lines, then the beta rules. Auth is set by the
// caller first so "-authorization" can still remove it.
export function applyIdentityAndHeaders(headers: Record<string, string>, q: NodeQuirks, { messagesPath = false }: { messagesPath?: boolean } = {}): Record<string, string> {
  applyHeaderOps(headers, parseHeaderLines(mimicHeaderText(q)));
  applyHeaderOps(headers, parseHeaderLines(q.overrides?.headers));
  if (messagesPath) filterBeta(headers, { dropped: q.droppedBetas, stripAll: q.stripBeta === true });
  return headers;
}

// "ours => theirs" (or →) per line.
export function parseModelRenames(textValue: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of String(textValue || "").split("\n")) {
    const m = /^\s*(\S+)\s*(?:=>|→)\s*(\S+)\s*$/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const dropList = (textValue: string | undefined | null): string[] =>
  String(textValue || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

// Deep merge in place; null deletes. Arrays and scalars replace.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const cur = target[k];
    if (v === null) delete target[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v && typeof v === "object" ? structuredClone(v) : v;
  }
  return target;
}

// The body the upstream gets: model rename, streaming, dropped fields, then
// the JSON merge (so the merge can put back anything). Returns a copy.
export function applyBodyOverrides(body: unknown, o: RawOverrides | undefined): unknown {
  if (!o || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const out = structuredClone(body) as Record<string, unknown>;
  const renames = parseModelRenames(o.models);
  if (typeof out.model === "string" && renames[out.model]) out.model = renames[out.model];
  if (o.stream === "always") out.stream = true;
  if (o.stream === "never") { out.stream = false; delete out.stream_options; }
  for (const k of dropList(o.drop)) delete out[k];
  const merge = parseBodyOverride(o.body).value;
  if (merge) deepMerge(out, merge);
  return out;
}

const API_SUFFIX_RE = /\/(chat\/completions|messages|responses)$/;

// Path replaces the API path after the base; query params are set (they win
// over ones already on the URL).
export function applyUrlOverrides(url: string, o: RawOverrides | undefined, { replacePath = true }: { replacePath?: boolean } = {}): string {
  if (!o || (!o.path && !o.query)) return url;
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  if (o.path && replacePath) u.pathname = u.pathname.replace(/\/+$/, "").replace(API_SUFFIX_RE, "") + o.path;
  if (o.query) for (const [k, v] of new URLSearchParams(o.query)) u.searchParams.set(k, v);
  return u.toString();
}

// ---- Sample request for the dashboard preview ----

export const DEFAULT_PATHS: Record<RouteProtocol, string> = { "openai-chat": "/chat/completions", "openai-responses": "/responses", anthropic: "/messages" };
// What Claude Code sends with CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS on, as an example client.
export const SAMPLE_CLIENT_BETAS = "oauth-2025-04-20,interleaved-thinking-2025-05-14";

export function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "…";
  const dash = k.indexOf("-");
  return `${k.slice(0, Math.min(6, dash + 1 || 3))}…${k.slice(-4)}`;
}

export interface SampleInput {
  baseUrl: string;
  protocol: RouteProtocol;
  model?: string;
  apiKey?: string;           // masked before it goes anywhere
  // Shown in place of the key when the raw key isn't available (saved endpoints).
  keyPlaceholder?: string;
  quirks: NodeQuirks;
}
export interface SampleRequest {
  url: string;
  headers: [string, string][];
  body: unknown;
  jsonError: string;
}

// The request 10router would send for a one-line "hi", with the key masked.
export function buildSampleRequest({ baseUrl, protocol, model, apiKey = "", keyPlaceholder = "", quirks }: SampleInput): SampleRequest {
  const o = quirks.overrides || {};
  const base = String(baseUrl || "https://api.example.com/v1").replace(/\?.*$/, "").replace(/\/+$/, "").replace(API_SUFFIX_RE, "");
  const q0 = /\?(.*)$/.exec(String(baseUrl || ""))?.[1] || "";
  const url = applyUrlOverrides(base + DEFAULT_PATHS[protocol] + (q0 ? `?${q0}` : ""), o);
  const key = maskKey(apiKey) || keyPlaceholder;
  const isMsg = protocol === "anthropic";
  const h: Record<string, string> = { "content-type": "application/json" };
  const mode: AuthHeader = quirks.authHeader || (isMsg ? "both" : quirks.apiKeyHeader === "api-key" ? "api-key" : "bearer");
  applyAuthHeader(h, mode, key);
  if (isMsg) {
    h["anthropic-version"] = "2023-06-01";
    h["anthropic-beta"] = SAMPLE_CLIENT_BETAS;
  }
  applyIdentityAndHeaders(h, quirks, { messagesPath: isMsg });
  const m = model || "model-id";
  let body: Record<string, unknown> = protocol === "openai-responses"
    ? { model: m, input: [{ role: "user", content: "hi" }], max_output_tokens: 1024, stream: true }
    : { model: m, messages: [{ role: "user", content: "hi" }], max_tokens: 1024, stream: true };
  if (protocol === "openai-chat" && quirks.maxCompletionTokens) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  body = applyBodyOverrides(body, o) as Record<string, unknown>;
  return { url, headers: Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]), body, jsonError: parseBodyOverride(o.body).error };
}

// Count of settings that differ from defaults, for the "N overrides" summary.
export function activeOverrides(q: NodeQuirks, { protoOverride }: { protoOverride?: string } = {}): string[] {
  const o = q.overrides || {};
  return [
    protoOverride && protoOverride !== "auto" && "API type",
    q.authHeader && "auth",
    q.stripBeta && "strip beta",
    q.droppedBetas?.length && `${q.droppedBetas.length} dropped flag${q.droppedBetas.length === 1 ? "" : "s"}`,
    q.maxCompletionTokens && "max_completion_tokens",
    q.mimic && q.mimic !== "none" && "impersonating",
    o.path && "path", o.query && "query", o.headers && "headers", o.body && "body merge",
    o.drop && "dropped fields", o.models && "model renames", o.stream && o.stream !== "auto" && "streaming",
    o.timeout && "timeout", o.retries && "retries", o.proxy && "proxy",
    q.blockForeignTools && "tool guard", q.stripReasoning && "strip reasoning",
  ].filter((x): x is string => typeof x === "string");
}
