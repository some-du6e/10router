// "Recent requests" on a custom endpoint's page: the last upstream requests the
// router sent to that endpoint, each with the exact request and response, so a
// weird endpoint can be debugged from the dashboard. In memory only (lost on
// restart), MAX_PER_ENDPOINT per endpoint, keys masked.
//
// Captured where the executors call fetch: every fetch made while a request for
// a custom endpoint is running (recordEndpointRequests) is logged, retries
// included, after every rewrite.
//
// Fail-open: logging must never break a request, so every handler swallows errors.

import { AsyncLocalStorage } from "node:async_hooks";
import { parseRejectedBetas, splitBetas } from "open-sse/utils/anthropicBeta.js";
import { makeRedactor } from "@/lib/endpointDetect.js";
import { isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers.js";

export const MAX_PER_ENDPOINT = 20;
const MAX_CAPTURE_BYTES = 256 * 1024; // body bytes kept while a request runs
const MAX_TEXT = 8000;                // characters kept per request/response
const AUTH_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "proxy-authorization"]);

export interface EndpointRequestEntry {
  id: string;
  at: string;              // ISO time it finished
  kind: "request" | "fix";
  ok: boolean;
  status: number;          // 0 = network error; fix rows carry the 400 they fixed
  ms: number;
  model: string;
  prompt: string;          // the last user message, trimmed ("hi")
  error: string;           // upstream error message, if any
  note: string;            // "200 · 1 token", "400", "auto-fix"
  reply: string;           // the reply text, when there was one
  flags?: string[];        // fix rows: the beta flags dropped
  request?: string;        // "POST url\nheaders\n\nbody", key masked
  response?: string;       // "HTTP 200\nheaders\n\nbody"
}

interface Ctx { provider: string; key: string; origin: string }
interface Pending {
  ctx: Ctx;
  start: number;
  method: string;
  url: string;
  reqHeaders: [string, string][];
  reqBody: Buffer[];
  reqBytes: number;
  status: number;
  resHeaders: [string, string][];
  resBody: Buffer[];
  resBytes: number;
  done: boolean;
}

interface Store {
  als: AsyncLocalStorage<Ctx>;
  logs: Map<string, EndpointRequestEntry[]>;
  seq: number;
}

const FETCH_TAP = Symbol.for("10router.fetchTap");

// One store per process, even when Next bundles this module into several routes.
const KEY = Symbol.for("10router.endpointRequestLog");
const g = globalThis as unknown as Record<symbol, Store | undefined>;
const store: Store = g[KEY] ||= (() => {
  const s: Store = { als: new AsyncLocalStorage<Ctx>(), logs: new Map(), seq: 0 };
  subscribe(s);
  return s;
})();

export const isCustomEndpoint = (provider: unknown) =>
  isOpenAICompatibleProvider(provider) || isAnthropicCompatibleProvider(provider);

// Run `fn` (one routed request) with logging on, when `provider` is a custom
// endpoint. Only requests to the endpoint's own host are kept (not anything
// else the request happens to call).
export function recordEndpointRequests<T>(provider: string, credentials: { apiKey?: unknown; providerSpecificData?: { baseUrl?: unknown } | null } | null | undefined, fn: () => T): T {
  if (!isCustomEndpoint(provider)) return fn();
  let origin = "";
  try { origin = new URL(String(credentials?.providerSpecificData?.baseUrl || "")).origin; } catch { /* keep "" */ }
  // No host to match against: logging would catch every call the request makes.
  if (!origin || origin === "null") return fn();
  const key = typeof credentials?.apiKey === "string" ? credentials.apiKey : "";
  return store.als.run({ provider, key, origin }, fn);
}

export function getEndpointRequests(provider: string): EndpointRequestEntry[] {
  return [...(store.logs.get(provider) || [])];
}

export function clearEndpointRequests(provider: string): void {
  store.logs.delete(provider);
}

// For tests: add an entry as if it had been captured.
export function pushEndpointRequest(provider: string, entry: EndpointRequestEntry): void {
  const list = store.logs.get(provider) || [];
  list.push(entry);
  while (list.length > MAX_PER_ENDPOINT) list.shift();
  store.logs.set(provider, list);
}

// "pat-…7f2a": the same rule the key list uses (src/app/api/providers/route.js):
// a 4-char tail, plus the key's own prefix only while both stay within a third
// of the key. Short keys show nothing of themselves.
export function maskKey(key: string): string {
  const k = String(key || "");
  const dash = k.indexOf("-");
  const head = dash > 0 && dash < 5 ? k.slice(0, dash + 1) : "";
  if (k.length < 12) return `${head || "key"}…`;
  const tail = k.slice(-4);
  return `${head && head.length + tail.length <= k.length / 3 ? head : "key"}…${tail}`;
}

// ---- Capture --------------------------------------------------------------

// Seen through the engine's fetch tap (open-sse/utils/proxyFetch.js), which every
// executor request goes through. Node 22's undici publishes no body events on
// its diagnostics channels, so the tap reads the bodies itself: the request
// from the fetch options, the response from a clone the caller never sees.

type HeadersLike = Headers | [string, string][] | Record<string, unknown> | undefined;

function headerPairs(raw: HeadersLike): [string, string][] {
  if (!raw) return [];
  if (typeof (raw as Headers).forEach === "function" && !Array.isArray(raw)) {
    const out: [string, string][] = [];
    (raw as Headers).forEach((v, k) => out.push([k, v]));
    return out;
  }
  if (Array.isArray(raw)) return raw.map(([k, v]) => [String(k), String(v)]);
  return Object.entries(raw).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]);
}

function bodyBytes(body: unknown): Buffer | null {
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  return null;
}

async function readCapped(res: Response, p: Pending) {
  const reader = res.body?.getReader();
  if (!reader) return;
  try {
    while (p.resBytes < MAX_CAPTURE_BYTES) {
      const { done, value } = await reader.read();
      if (done) return;
      p.resBody.push(Buffer.from(value));
      p.resBytes += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function subscribe(s: Store) {
  (globalThis as unknown as Record<symbol, unknown>)[FETCH_TAP] = {
    start(url: string, options: { method?: string; headers?: HeadersLike; body?: unknown } = {}) {
      try {
        const ctx = s.als.getStore();
        if (!ctx) return null;
        const u = new URL(url);
        if (u.origin !== ctx.origin) return null;
        const reqBody = bodyBytes(options.body);
        const p: Pending = {
          ctx, start: Date.now(), method: (options.method || "GET").toUpperCase(), url: u.href,
          reqHeaders: headerPairs(options.headers), reqBody: reqBody ? [reqBody.subarray(0, MAX_CAPTURE_BYTES)] : [], reqBytes: reqBody?.length || 0,
          status: 0, resHeaders: [], resBody: [], resBytes: 0, done: false,
        };
        return {
          done(res: Response) {
            try {
              p.status = res.status;
              p.resHeaders = headerPairs(res.headers);
              readCapped(res.clone(), p).catch(() => {}).finally(() => finish(s, p, null));
            } catch { /* fail-open */ }
            return res;
          },
          fail(error: unknown) { try { finish(s, p, error); } catch { /* fail-open */ } },
        };
      } catch { return null; }
    },
  };
}

const cut = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n… (${t.length - MAX_TEXT} more characters)` : t);
const pretty = (t: string) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } };

// What the user said last, for the summary line.
export function lastPrompt(body: unknown): string {
  const b = body as { messages?: unknown[]; input?: unknown } | null;
  const textOf = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).filter(Boolean).join(" ");
    return "";
  };
  let text = "";
  if (Array.isArray(b?.messages)) {
    const user = [...b.messages].reverse().find((m) => (m as { role?: string })?.role === "user") as { content?: unknown } | undefined;
    text = textOf(user?.content);
  } else if (typeof b?.input === "string") text = b.input;
  else if (Array.isArray(b?.input)) {
    const user = [...b.input].reverse().find((m) => (m as { role?: string })?.role === "user") as { content?: unknown } | undefined;
    text = textOf(user?.content);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

// Output tokens from a JSON body or the last usage block of an SSE stream.
export function outputTokens(text: string): number | null {
  const all = [...text.matchAll(/"(?:output_tokens|completion_tokens)"\s*:\s*(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

// The reply text from an OpenAI / Anthropic / Responses JSON body or SSE stream.
export function replyText(text: string): string {
  const parts: string[] = [];
  const take = (j: unknown) => {
    const o = j as Record<string, any> | null;
    if (!o || typeof o !== "object") return;
    const c = o.choices?.[0];
    if (typeof c?.message?.content === "string") parts.push(c.message.content);
    if (typeof c?.delta?.content === "string") parts.push(c.delta.content);
    if (Array.isArray(o.content)) for (const b of o.content) if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    if (o.type === "content_block_delta" && typeof o.delta?.text === "string") parts.push(o.delta.text);
    if (o.type === "response.output_text.delta" && typeof o.delta === "string") parts.push(o.delta);
    if (typeof o.output_text === "string") parts.push(o.output_text);
  };
  try { take(JSON.parse(text)); } catch {
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s*(.+)$/.exec(line);
      if (m && m[1] !== "[DONE]") { try { take(JSON.parse(m[1])); } catch { /* skip */ } }
    }
  }
  const out = parts.join("").replace(/\s+/g, " ").trim();
  return out.length > 80 ? `${out.slice(0, 79)}…` : out;
}

export function errorMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
    if (typeof m === "string") return m.slice(0, 200);
  } catch { /* not JSON */ }
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function finish(s: Store, p: Pending, error: unknown) {
  if (p.done) return;
  p.done = true;
  const { ctx } = p;
  const redact = makeRedactor(ctx.key);
  const masked = maskKey(ctx.key);
  const showHeader = ([k, v]: [string, string]) => {
    if (!AUTH_HEADERS.has(k.toLowerCase())) return `${k}: ${redact(v)}`;
    const scheme = /^(bearer|basic|token)\s+/i.exec(v)?.[0] || "";
    return `${k}: ${scheme}${masked}`;
  };
  const reqText = redact(Buffer.concat(p.reqBody).toString("utf8"));
  const resText = redact(Buffer.concat(p.resBody).toString("utf8"));
  let body: unknown = null;
  try { body = JSON.parse(reqText); } catch { /* not JSON */ }
  const model = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : "";
  const ok = !error && p.status >= 200 && p.status < 300;
  const tokens = ok ? outputTokens(resText) : null;
  const errText = error ? redact((error as Error)?.message || String(error)) : ok ? "" : errorMessage(resText);
  const ms = Date.now() - p.start;
  const entry: EndpointRequestEntry = {
    id: `r${++s.seq}-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    kind: "request", ok, status: p.status, ms, model, prompt: lastPrompt(body), error: errText, reply: ok ? replyText(resText) : "",
    note: error ? "no answer" : tokens != null ? `${p.status} · ${tokens} token${tokens === 1 ? "" : "s"}` : `${p.status} · ${ms}ms`,
    request: `${p.method} ${redact(p.url)}\n${p.reqHeaders.map(showHeader).join("\n")}\n\n${cut(pretty(reqText))}`,
    response: error ? `No response\n\n${errText}` : `HTTP ${p.status}\n${p.resHeaders.map(showHeader).join("\n")}\n\n${cut(pretty(resText))}`,
  };
  pushEndpointRequest(ctx.provider, entry);
  // A gateway that named beta flags it rejects: the executor drops them and
  // retries (open-sse/executors/default.js). Say so between the two requests.
  if (p.status === 400) {
    const sent = new Set(p.reqHeaders.filter(([k]) => k.toLowerCase() === "anthropic-beta").flatMap(([, v]) => splitBetas(v)));
    const flags = parseRejectedBetas(resText).filter((f) => sent.has(f));
    if (flags.length) {
      pushEndpointRequest(ctx.provider, {
        id: `${entry.id}-fix`, at: entry.at, kind: "fix", ok: false, status: 400, ms: 0, model, prompt: "", error: "", reply: "",
        note: "auto-fix", flags,
      });
    }
  }
}
