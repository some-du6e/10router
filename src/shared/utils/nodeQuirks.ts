// Per-endpoint compatibility fixes for user-added OpenAI/Anthropic-compatible
// nodes. Stored on the node and copied onto every connection's
// providerSpecificData, which is where the executor reads them.
//   stripBeta            send no anthropic-beta header at all
//   droppedBetas         beta flags this endpoint rejected (learned at runtime)
//   maxCompletionTokens  rename max_tokens → max_completion_tokens (Snowflake chat)
//   modelRoutes          model → API path, for endpoints that answer on both
//                        Anthropic Messages and OpenAI (see resolveCompatibleRoute)
//   apiKeyHeader         "api-key": send the key in an api-key header, not Bearer (Azure)
//   authHeader           how the key is sent: bearer / x-api-key / api-key / both.
//                        Unset = the protocol's default (and apiKeyHeader).
//   mimic                send a client's identity headers (Claude Code, Codex, Gemini CLI)
//   customHeaders        the header lines for mimic "custom"
//   overrides            Ultra advanced: raw path/query/header/body/connection overrides
//   blockForeignTools    drop tool calls for tools the client never offered
//   stripReasoning       remove reasoning/thinking from replies
// Applied by open-sse/handlers/chatCore/endpointOverrides.ts (shapes: endpointOverrides.ts).
export const QUIRK_KEYS: readonly (keyof NodeQuirks)[] = [
  "stripBeta", "droppedBetas", "maxCompletionTokens", "modelRoutes", "apiKeyHeader",
  "authHeader", "mimic", "customHeaders", "overrides", "blockForeignTools", "stripReasoning",
];
export const ROUTE_PROTOCOLS: readonly RouteProtocol[] = ["anthropic", "openai-chat", "openai-responses"];
const MAX_ROUTES = 500;

export type RouteProtocol = "anthropic" | "openai-chat" | "openai-responses";
export type AuthHeader = "bearer" | "x-api-key" | "api-key" | "both";
export type Mimic = "none" | "claude-code" | "codex" | "gemini-cli" | "custom";
export type StreamMode = "auto" | "always" | "never";

export const AUTH_HEADERS: readonly AuthHeader[] = ["bearer", "x-api-key", "api-key", "both"];
export const MIMICS: readonly Mimic[] = ["none", "claude-code", "codex", "gemini-cli", "custom"];
export const STREAM_MODES: readonly StreamMode[] = ["auto", "always", "never"];

// Ultra advanced, as the user typed it (text fields stay text so the form
// round-trips). Only valid values are kept: a body that isn't a JSON object, a
// path with a host in it, a proxy with an unknown scheme are dropped, never
// saved half-broken.
export type RawOverrides = {
  path?: string;     // replaces the API path ("/v2/chat")
  query?: string;    // "a=1&b=2", set on every request (wins over the URL's own)
  headers?: string;  // "name: value" sets, "-name" removes; one per line
  body?: string;     // JSON object, deep-merged; null deletes a field
  drop?: string;     // top-level body fields to delete, comma/space separated
  models?: string;   // "ours => theirs" per line
  stream?: StreamMode;
  timeout?: string;  // seconds until the upstream answers (headers)
  retries?: string;  // retries on 429 / 5xx / network errors
  proxy?: string;    // http(s):// or socks5:// for this endpoint only
};

// Sanitized quirks. apiKeyHeader / authHeader are null only in an edit (keepEmpty) that turns them off.
export type NodeQuirks = {
  stripBeta?: boolean;
  droppedBetas?: string[];
  maxCompletionTokens?: boolean;
  modelRoutes?: Record<string, RouteProtocol>;
  apiKeyHeader?: "api-key" | null;
  authHeader?: AuthHeader | null;
  mimic?: Mimic;
  customHeaders?: string;
  overrides?: RawOverrides;
  blockForeignTools?: boolean;
  stripReasoning?: boolean;
};

// Identity headers each client sends. Kept here (not imported from open-sse,
// which pulls node:os) so the dashboard can show them; tests/unit/
// endpoint-overrides.test.js checks they match the executors' own values.
export const CLIENT_VERSIONS = { claudeCode: "2.1.258", codex: "0.136.0", geminiCli: "0.34.0", geminiApiClient: "google-genai-sdk/1.41.0 gl-node/v22.19.0" } as const;
export const MIMIC_HEADERS: Record<Exclude<Mimic, "none" | "custom">, string> = {
  "claude-code": `user-agent: claude-cli/${CLIENT_VERSIONS.claudeCode} (external, sdk-cli)\nx-app: cli\nanthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14`,
  codex: `user-agent: codex_cli_rs/${CLIENT_VERSIONS.codex}\noriginator: codex_cli_rs`,
  "gemini-cli": `user-agent: GeminiCLI/${CLIENT_VERSIONS.geminiCli}\nx-goog-api-client: ${CLIENT_VERSIONS.geminiApiClient}`,
};
export const MIMIC_LABELS: Record<Mimic, string> = { none: "None", "claude-code": "Claude Code", codex: "Codex CLI", "gemini-cli": "Gemini CLI", custom: "Custom" };

// The header lines a mimic setting sends ("" for none).
export function mimicHeaderText(q: Pick<NodeQuirks, "mimic" | "customHeaders">): string {
  const m = q.mimic || "none";
  if (m === "none") return "";
  if (m === "custom") return q.customHeaders || "";
  return MIMIC_HEADERS[m];
}

const isRouteProtocol = (p: unknown): p is RouteProtocol =>
  typeof p === "string" && (ROUTE_PROTOCOLS as readonly string[]).includes(p);
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

const FLAG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,120}$/;
// No CR/LF anywhere: these end up in URLs and headers.
const CTL_RE = /[\r\n\0]/;
const MAX_TEXT = 4000;
const PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks:"];

const text = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;

export function isValidOverridePath(p: string): boolean {
  return p.startsWith("/") && !p.startsWith("//") && !/[\s?#\\]/.test(p) && !p.includes("://") && p.length <= 300;
}
export function isValidProxyUrl(p: string): boolean {
  if (CTL_RE.test(p)) return false;
  try { return PROXY_SCHEMES.includes(new URL(p).protocol); } catch { return false; }
}
// The body override as an object, or the reason it isn't one.
export function parseBodyOverride(raw: string | undefined): { value: Record<string, unknown> | null; error: string } {
  if (!raw || !raw.trim()) return { value: null, error: "" };
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { value: null, error: "it must be a JSON object" };
    return { value: v as Record<string, unknown>, error: "" };
  } catch (e) {
    return { value: null, error: (e as Error).message };
  }
}

// Keep only well-formed override fields. Empty strings mean "not set" and go.
export function sanitizeOverrides(raw: unknown): RawOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: RawOverrides = {};
  const path = text(r.path, 300)?.trim();
  if (path && isValidOverridePath(path)) out.path = path;
  const query = text(r.query, 1000)?.trim().replace(/^\?/, "");
  if (query && !CTL_RE.test(query) && !query.includes("#")) out.query = query;
  for (const k of ["headers", "models"] as const) {
    const v = text(r[k]);
    if (v && v.trim()) out[k] = v.replace(/\r/g, "");
  }
  const drop = text(r.drop, 1000)?.trim();
  if (drop && !CTL_RE.test(drop)) out.drop = drop;
  const body = text(r.body, 20_000);
  if (body && parseBodyOverride(body).value) out.body = body;
  if (isOneOf(STREAM_MODES, r.stream) && r.stream !== "auto") out.stream = r.stream;
  const timeout = Number(text(r.timeout, 10) ?? r.timeout);
  if (Number.isFinite(timeout) && timeout > 0 && timeout <= 3600 && String(r.timeout ?? "").trim()) out.timeout = String(timeout);
  const retries = Number(text(r.retries, 4) ?? r.retries);
  if (Number.isInteger(retries) && retries >= 0 && retries <= 10 && String(r.retries ?? "").trim()) out.retries = String(retries);
  const proxy = text(r.proxy, 500)?.trim();
  if (proxy && isValidProxyUrl(proxy)) out.proxy = proxy;
  return out;
}

// Keep only known keys with the right types. keepEmpty keeps false/[]/{}/null so
// an edit can switch a fix back off.
export function sanitizeNodeQuirks(raw: unknown, { keepEmpty = false }: { keepEmpty?: boolean } = {}): NodeQuirks {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: NodeQuirks = {};
  for (const k of ["stripBeta", "maxCompletionTokens", "blockForeignTools", "stripReasoning"] as const) {
    const v = r[k];
    if (typeof v === "boolean" && (v || keepEmpty)) out[k] = v;
  }
  if (r.apiKeyHeader === "api-key" || r.apiKeyHeader === true) out.apiKeyHeader = "api-key"; // detection reports `true`
  else if (keepEmpty && r.apiKeyHeader === null) out.apiKeyHeader = null;
  if (isOneOf(AUTH_HEADERS, r.authHeader)) out.authHeader = r.authHeader;
  else if (keepEmpty && r.authHeader === null) out.authHeader = null;
  if (isOneOf(MIMICS, r.mimic) && (r.mimic !== "none" || keepEmpty)) out.mimic = r.mimic;
  const custom = text(r.customHeaders);
  if (custom !== null && (custom.trim() || keepEmpty)) out.customHeaders = custom.replace(/\r/g, "");
  if (r.overrides !== undefined) {
    const o = sanitizeOverrides(r.overrides);
    if (Object.keys(o).length || keepEmpty) out.overrides = o;
  }
  if (Array.isArray(r.droppedBetas)) {
    const flags = [...new Set(r.droppedBetas.map((f: unknown) => String(f).trim()).filter((f) => FLAG_RE.test(f)))].slice(0, 50);
    if (flags.length || keepEmpty) out.droppedBetas = flags;
  }
  if (r.modelRoutes && typeof r.modelRoutes === "object" && !Array.isArray(r.modelRoutes)) {
    const routes = Object.fromEntries(Object.entries(r.modelRoutes as Record<string, unknown>)
      .filter((e): e is [string, RouteProtocol] => MODEL_RE.test(e[0]) && isRouteProtocol(e[1]))
      .slice(0, MAX_ROUTES));
    if (Object.keys(routes).length || keepEmpty) out.modelRoutes = routes;
  }
  return out;
}
