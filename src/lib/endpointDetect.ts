// Endpoint detection for "Add endpoint": paste a URL + key, work out the protocol,
// base URL, models and auth, using FREE requests only. Nothing here may trigger a
// billed generation: chat probes send an empty `messages` array, which every API
// we know rejects with a 400 before running a model, and every probe carries a
// tiny output cap in case a proxy fills the empty conversation in anyway.
//
// Results are tri-state. Every probe is recorded in `steps` (status + the first
// part of the body, secrets redacted) so the user can see why we concluded anything.
//
// Imported by the dashboard too: no node:* imports in this file.

import type { CatalogLabModel, CatalogProvider, EndpointCatalog } from "./endpointCatalog.js";

// ---- Types -------------------------------------------------------------------

export type Protocol = "anthropic" | "openai-chat" | "openai-responses";
export type KeyConfirmed = "confirmed" | "likely" | "unknown";
export type ModelsSource = "models" | "catalog" | "guessed" | "none";
type StopReason = "auth" | "denied" | "rate" | "generated" | "failing" | "deadline" | "aborted";
// Stops that mean the key itself can't be used.
const keyStop = (s: StopReason | null) => s === "auth" || s === "denied";
type ErrorShape = "anthropic" | "openai" | "generic";
export type Classification = "network" | "rate" | "server" | "generated" | "html" | "ok" | "gated" | "auth" | "other" | "missing" | "unknown-model" | "accepted" | "model-denied";

// One probe, as shown to the user (secrets redacted).
export interface DetectStep {
  label: string;
  method: string;
  url: string;
  status: number;           // 0 = network error
  preview: string;
  html?: boolean;
  retried?: boolean;
}

// Quirks read off the free probes' error bodies.
export interface DetectQuirks {
  maxCompletionTokens?: boolean;
  generatesOnEmpty?: boolean;
  apiKeyHeader?: boolean;
}

// What detectEndpoint returns. `ok: false` carries `error` (and maybe
// clientGated / authRejected / rateLimited); `ok: true` carries the rest.
export interface DetectResult {
  ok: boolean;
  error?: string;
  baseUrl?: string;
  steps: DetectStep[];
  protocol?: Protocol;
  protocols?: Protocol[];
  routes?: Record<string, Protocol>;
  byProtocol?: Partial<Record<Protocol, string[]>> | null;
  models?: string[];
  modelsSource?: ModelsSource;
  keyConfirmed?: KeyConfirmed;
  quirks?: DetectQuirks;
  partial?: boolean;
  partialReason?: string | null;
  authRejected?: boolean;
  rateLimited?: boolean;
  clientGated?: boolean;
  suggestedName?: string;
  suggestedPrefix?: string;
}

// What discoverModels returns. The routing fields are only set when it was
// asked about several protocols; `complete` is then per protocol.
export interface DiscoverResult {
  models: string[];
  source: ModelsSource;
  catalogName?: string;
  steps: DetectStep[];
  complete: boolean | Record<string, boolean>;
  partial: boolean;
  partialReason: string | null;
  authRejected: boolean;
  routes?: Record<string, string>;
  counts?: Record<string, number>;
  byProtocol?: Record<string, string[]>;
  allComplete?: boolean;
}

// The catalog as synced (see endpointCatalog.js), or a bare provider list.
export type CatalogInput = CatalogProvider[] | Partial<EndpointCatalog>;
type MatchedProvider = CatalogProvider & { score: number };

type HeaderMap = Record<string, string>;
// The subset of fetch the probes use; tests inject a fake.
export interface ProbeResponse {
  status: number;
  text(): Promise<string>;
  headers?: { get?(name: string): string | null } | null;
}
export type DetectFetch = (url: string, init: { method: string; headers: HeaderMap; body?: string; signal: AbortSignal }) => Promise<ProbeResponse>;
type Sleep = (ms: number) => Promise<unknown>;
interface ProbeResult { status: number; text: string; json: unknown; step: DetectStep; contentType?: string | null; skipped?: boolean }
// `halted()` says why probing must end (deadline or client abort), or null.
type Prober = ((label: string, method: string, target: string, opts?: { headers?: HeaderMap; body?: Record<string, unknown> }) => Promise<ProbeResult>) & { halted(): StopReason | null };
interface AuthHeaders { bearer: HeaderMap; "x-api-key": HeaderMap; "api-key": HeaderMap; both: HeaderMap }
interface ProbeSpec { path: string; label: string; headers: HeaderMap; body: Record<string, unknown> }
// Parsed JSON, read defensively: any property may be anything.
type Json = Record<string, unknown>;

const PROBE_TIMEOUT_MS = 8000;
const BODY_PREVIEW = 300;
const PROBE_CONCURRENCY = 3;     // model probes in flight per path
const MAX_CANDIDATES = 40;       // ids asked about per path (a matched provider's own list may go over, up to the next cap)
const MAX_MATCHED_CANDIDATES = 80;
const MAX_RATE_RETRIES = 3;      // per probe, on 429
const MAX_RETRY_WAIT_MS = 10_000;
const MAX_MODEL_PAGES = 10;      // /models pagination cap
const CANARY = "10router-no-such-model";
const CONTROL_PATH = "/10router-no-such-path";
const DETECT_DEADLINE_MS = 45_000; // whole detection; the UI gives up at 60s
const MAX_CONSECUTIVE_FAILURES = 6; // network / timeout / 5xx in a row on one path
const MODEL_DENIED_STOP = 3;     // the same model-access refusal on this many models = the key, not the model
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Paths users paste that aren't part of the base URL.
const TRAILING_PATHS = ["/chat/completions", "/messages", "/responses", "/models", "/embeddings", "/completions"];

// Hosts on the user's own network: no scheme typed means http, not https.
const LAN_HOST_RE = /^(localhost|.+\.localhost|.+\.local|.+\.lan|.+\.internal|.+\.home\.arpa|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[(::1?|f[cd][0-9a-f:]*|fe80[0-9a-f:]*)\])$/i;
export function isLanHost(host: unknown): boolean {
  const h = String(host || "").toLowerCase().replace(/\.+$/, "");
  if (!h) return false;
  // Single-label names are docker/compose service names ("ollama", "vllm").
  return LAN_HOST_RE.test(h) || (!h.includes(".") && !h.startsWith("["));
}

// Host part of a URL typed without a scheme: "user@ollama:11434/v1" -> "ollama".
function bareHost(s: string): string {
  const authority = s.split(/[/?#]/)[0].replace(/^[^@]*@/, "");
  return authority.startsWith("[") ? authority.replace(/\].*$/, "]") : authority.replace(/:\d*$/, "");
}

// Cut a pasted URL down to its base. Keeps query params (Azure api-version).
export function normalizeUrl(raw: unknown): string | null {
  let s = String(raw || "").trim().replace(/^["'<`“‘]+|["'>`”’]+$/g, "");
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = (isLanHost(bareHost(s)) ? "http://" : "https://") + s.replace(/^\/+/, "");
  let url;
  try { url = new URL(s); } catch { return null; }
  let path = url.pathname.replace(/\/+$/, "");
  for (let changed = true; changed;) {
    changed = false;
    for (const p of TRAILING_PATHS) {
      if (path.toLowerCase().endsWith(p)) { path = path.slice(0, -p.length).replace(/\/+$/, ""); changed = true; }
    }
  }
  return `${url.origin}${path}${url.search}`;
}

// base + path, keeping the base's query string (Azure ?api-version=) after the path.
export function joinUrl(base: string, path = "", params: Record<string, unknown> | null = null): string {
  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/+$/, "") + path;
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v as string);
  return u.toString();
}

// Azure OpenAI / AI Foundry: keys go in an `api-key` header, not Bearer.
export function isAzureHost(base: string): boolean {
  try {
    const u = new URL(base);
    return /\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com|azure-api\.net)$/i.test(u.hostname) || u.searchParams.has("api-version");
  } catch { return false; }
}

// Strip what people paste around a key: zero-width chars, smart or plain quotes,
// a header name, "Bearer ", whitespace and line breaks.
const QUOTES = "\"'`“”‘’«»‹›";
const EDGE_QUOTES_RE = new RegExp(`^[${QUOTES}]+|[${QUOTES}]+$`, "g");
export function cleanKey(raw: unknown): string {
  let s = String(raw || "").replace(/[​-‍⁠﻿­]/g, "");
  for (let prev: string | null = null; prev !== s;) {
    prev = s;
    s = s.trim().replace(EDGE_QUOTES_RE, "").trim()
      .replace(/^(authorization|x-api-key|api-key)\s*[:=]\s*/i, "")
      .replace(/^Bearer\s+/i, "");
  }
  return s.replace(/\s+/g, "");
}

// Removes the key (and any key-looking query param or bearer token) from text
// shown to the user, in every form a server might echo it: raw, JSON-escaped
// ("/" -> "\/"), URL-encoded and base64. A short key is only replaced as a whole
// token, so a 3-char key doesn't turn every word containing it into "<key>".
const SECRET_PARAM_RE = /([?&](?:key|api[_-]?key|token|access_token|auth|sig|signature|code)=)[^&#\s"']*/gi;
const BEARER_TOKEN_RE = /(bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// btoa needs Latin-1; go through UTF-8 bytes so any key encodes.
const base64 = (s: string) => btoa(Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join(""));
function keyForms(key: string): string[] {
  const b64 = base64(key);
  const forms = [key, key.replace(/\//g, "\\/"), encodeURIComponent(key), b64, b64.replace(/=+$/, ""), b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")];
  // Longest first, so a form that contains another is replaced whole.
  return [...new Set(forms)].filter(Boolean).sort((a, b) => b.length - a.length);
}
export function makeRedactor(key: string): (text: unknown) => string {
  const forms = key ? keyForms(key) : [];
  const short = key && key.length < 12 ? new RegExp(`(^|[^A-Za-z0-9_-])(${forms.map(escapeRe).join("|")})(?![A-Za-z0-9_-])`, "g") : null;
  return (text) => {
    let s = String(text ?? "");
    if (short) s = s.replace(short, "$1<key>");
    else for (const f of forms) s = s.split(f).join("<key>");
    return s.replace(SECRET_PARAM_RE, "$1<redacted>").replace(BEARER_TOKEN_RE, "$1<redacted>");
  };
}

// Candidate bases to probe: as given, plus `/v1` when the user stopped short of it.
export function candidateBases(base: string): string[] {
  const out = [base];
  const u = new URL(base);
  if (!/\/v\d+(beta)?$/i.test(u.pathname)) out.push(`${u.origin}${u.pathname.replace(/\/+$/, "")}/v1${u.search}`);
  return out;
}

// Raw entries of every model-list shape we've seen.
function modelEntries(json: unknown): unknown[] | null {
  const j = json as Json | null | undefined;
  return Array.isArray(json) ? json
    : Array.isArray(j?.data) ? j.data
    : Array.isArray(j?.models) ? j.models
    : Array.isArray(j?.result) ? j.result
    : null;
}
const entryId = (m: unknown) => String(typeof m === "string" ? m : ((m as Json | null)?.id || (m as Json | null)?.name || (m as Json | null)?.model || "")).replace(/^models\//, "").trim();

// Not chat models: embeddings, speech, transcription, image generation, rerankers.
const NON_CHAT_ID_RE = /embed|whisper|dall-e|gpt-image|imagen|stable-diffusion|sdxl|moderation|rerank|transcribe|(^|[-_/.])tts([-_.]|$)|text-to-speech|(^|[-_/])speech([-_]|$)/i;
function isChatEntry(m: unknown, id: string): boolean {
  if (m && typeof m === "object") {
    const o = m as Json;
    const methods = o.supportedGenerationMethods || o.supported_generation_methods;
    if (Array.isArray(methods) && methods.length && !methods.some((x) => /generateContent|chat|complet/i.test(x as string))) return false;
    const type = String(o.type || o.task || o.model_type || "").toLowerCase();
    if (/embed|image|audio|speech|tts|rerank|moderation|transcri/.test(type)) return false;
    const outMods = (o.architecture as Json | null | undefined)?.output_modalities || o.output_modalities;
    if (Array.isArray(outMods) && outMods.length && !outMods.includes("text")) return false;
  }
  return !NON_CHAT_ID_RE.test(id);
}

// Model ids from a list, deduped, in order. Non-chat models are dropped unless
// that would leave nothing (a dedicated embeddings server is still a list).
export function parseModelList(json: unknown, { chatOnly = true }: { chatOnly?: boolean } = {}): string[] {
  const arr = modelEntries(json);
  if (!arr) return [];
  const all = arr.map((m): [unknown, string] => [m, entryId(m)]).filter(([, id]) => id);
  const chat = chatOnly ? all.filter(([m, id]) => isChatEntry(m, id)) : all;
  return [...new Set((chat.length ? chat : all).map(([, id]) => id))];
}

// The next page of a model list, or null. Same origin only: the key goes with it.
export function nextModelPage(json: unknown, url: string): string | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const j = json as Json;
  let next: string | null = null;
  if (j.has_more && j.last_id) next = joinUrl(url.replace(/[?&]after_id=[^&]*/, ""), "", { after_id: j.last_id });
  const link = j.next || j.next_page_url || (j.links as Json | null | undefined)?.next || (j.pagination as Json | null | undefined)?.next;
  if (!next && typeof link === "string" && link) next = new URL(link, url).toString();
  const token = j.nextPageToken || j.next_page_token;
  if (!next && token) next = joinUrl(url, "", { pageToken: token });
  if (!next) return null;
  try { return new URL(next).origin === new URL(url).origin ? next : null; } catch { return null; }
}

// Decode one punycode label ("xn--mnchen-3ya" -> "münchen"), RFC 3492.
function punyDecode(input: string): string {
  const base = 36, tMin = 1, tMax = 26;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + 38));
  };
  const out: number[] = [];
  const b = Math.max(input.lastIndexOf("-"), 0);
  for (let j = 0; j < b; j++) out.push(input.charCodeAt(j));
  let n = 128, i = 0, bias = 72;
  for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (idx >= input.length) throw new Error("bad punycode");
      const c = input.charCodeAt(idx++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : base;
      if (digit >= base) throw new Error("bad punycode");
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
const decodeHost = (host: string) => host.split(".").map((l) => { if (!/^xn--/i.test(l)) return l; try { return punyDecode(l.slice(4)); } catch { return l; } }).join(".");

// Name, prefix and icon from the host. Prefix: initials of a multi-part name,
// else its first 4 letters; [a-z0-9] only.
const HOST_SKIP = new Set(["api", "gateway", "llm", "ai", "www", "inference", "openai", "v1", "app"]);
// Second-level labels under a country TLD: api.foo.co.uk -> "foo".
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "or", "ne", "go", "gob", "mil", "ltd", "plc", "nic", "info", "biz"]);
export function suggestName(base: string): string {
  const { hostname } = new URL(base);
  if (isLanHost(hostname) || /^\d+\.\d+\.\d+\.\d+$|^\[/.test(hostname)) return "Local endpoint";
  const labels = decodeHost(hostname.toLowerCase().replace(/\.+$/, "")).split(".").filter(Boolean);
  if (labels.length > 1) {
    const tld = labels.pop()!;
    if (tld.length === 2 && labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
  }
  const parts = labels.filter((p) => !HOST_SKIP.has(p));
  const label = parts[parts.length - 1] || labels[labels.length - 1] || hostname;
  const brand = label.replace(/computing$/, "").replace(/-.*$/, "") || label;
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}
export function makePrefix(name: unknown, taken: readonly unknown[] = []): string {
  const plain = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = plain.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  let p = (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] || "ep").slice(0, 4)).toLowerCase().replace(/[^a-z0-9]/g, "") || "ep";
  const used = new Set(taken.map((t) => String(t).toLowerCase()));
  if (!used.has(p)) return p;
  for (let i = 2; ; i++) if (!used.has(`${p}${i}`)) return `${p}${i}`;
}

// Endpoints with no model list (Snowflake Cortex: /v1/models 404) can still be
// asked about one model at a time for free, when they reject an unknown model id
// before anything else. Candidate ids come from the models.dev catalog, synced
// daily: `catalog` is [{ id, name, api, models: [ids] }] (see modelCatalog/sync.js).

// "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1" ->
// host regex (placeholders match one label) + path.
function apiPattern(api: unknown): { host: RegExp; path: string } | null {
  const m = /^https?:\/\/([^/]+)(\/[^?#]*)?/i.exec(String(api || ""));
  if (!m) return null;
  const hostRe = m[1].toLowerCase().split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/.]+");
  return { host: new RegExp(`^${hostRe}$`), path: (m[2] || "").replace(/\/+$/, "") };
}

// The catalog provider whose API URL matches this base, best path match first.
export function matchCatalogProvider(base: string, catalog: CatalogProvider[] = []): MatchedProvider | null {
  const u = new URL(base);
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  let best: MatchedProvider | null = null;
  for (const p of catalog) {
    const pat = apiPattern(p.api);
    if (!pat || !pat.host.test(host)) continue;
    const score = path === pat.path ? 3 : path.startsWith(pat.path) || pat.path.startsWith(path) ? 2 : 1;
    if (!best || score > best.score) best = { ...p, score };
  }
  return best;
}

// Generation number from a model id. Families that version in whole steps
// (claude-opus-4-5 / 4-8, gpt-5.x) group by the whole number; families that
// ship "3.5, 3.6, 3.7" as separate generations (qwen, glm) keep the decimal.
// Callers pick which with `decimal`.
export function majorVersion(id: unknown, decimal = false): number {
  const m = /(\d+)(?:[.-](\d+))?/.exec(String(id).replace(/^[a-z]+-?[a-z]*?(?=\d)/i, "").replace(/^[a-z]+(?=\d)/i, ""));
  if (!m) return 0;
  return decimal && m[2] !== undefined && m[2].length === 1 ? +`${m[1]}.${m[2]}` : +m[1];
}

// Snapshot suffixes: a date ("-20251001", "-2025-10-01", "-0613", "-250514")
// or a channel tag ("-latest", "-preview", "-exp-0827"). Gateways usually serve
// the undated alias, so a snapshot is only dropped when its alias is also a
// candidate; a catalog id that only exists dated is kept.
const SNAPSHOT_SUFFIX_RE = /(-\d{4}-?\d{2}-?\d{2}|-\d{6}|-\d{4}|-latest|-preview(-[\w.]+)?|-exp(-[\w.]+)?)$/i;
export function snapshotAlias(id: unknown): string | null {
  let s = String(id);
  for (let prev: string | null = null; prev !== s;) { prev = s; s = s.replace(SNAPSHOT_SUFFIX_RE, ""); }
  return s !== id && s ? s : null;
}
export function dropSnapshots(ids: string[]): string[] {
  const set = new Set(ids.map((x) => String(x).toLowerCase()));
  return ids.filter((id) => { const alias = snapshotAlias(id); return !alias || !set.has(alias.toLowerCase()); });
}

// The newest `gens` major versions of every model family the labs ship, and
// only families with a release in the last `maxAgeDays`. Old generations are
// left out on purpose: nobody adds an endpoint for them.
export function recentLabModels(labs: CatalogLabModel[] = [], gens = 3, maxAgeDays = 365, now = Date.now()): string[] {
  const cutoff = new Date(now - maxAgeDays * 864e5).toISOString().slice(0, 10);
  const kept = new Set(dropSnapshots(labs.map((m) => m.id)));
  const byFamily = new Map<string, CatalogLabModel[]>();
  for (const m of labs) {
    if (!kept.has(m.id)) continue;
    const key = `${m.lab}/${m.family}`;
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key)!.push(m);
  }
  const out: CatalogLabModel[] = [];
  for (const models of byFamily.values()) {
    if (!models.some((m) => m.date >= cutoff)) continue; // family went quiet
    // Whole-number versions unless the family's whole numbers barely move
    // (all its recent models share one major: qwen3.x, glm-5.x).
    // Versionless ids ("qwen-max", "qwen-plus") are aliases for whatever is
    // current, so they always stay. Everything else must be a recent generation.
    const versioned = models.filter((m) => majorVersion(m.id) > 0);
    const decimal = new Set(versioned.map((m) => majorVersion(m.id))).size < gens;
    const gen = (m: CatalogLabModel) => majorVersion(m.id, decimal);
    const keep = [...new Set(versioned.map(gen))].sort((a, b) => b - a).slice(0, gens);
    models.filter((m) => majorVersion(m.id) === 0 || keep.includes(gen(m)))
      .sort((a, b) => b.date.localeCompare(a.date))
      .forEach((m) => out.push(m));
  }
  return [...new Set(out.sort((a, b) => b.date.localeCompare(a.date)).map((m) => m.id))];
}

// Gateways often prefix a vendor's ids with its name (Snowflake: "openai-gpt-5").
// Learn the prefixes from the matched provider's own list.
function vendorPrefixes(models: string[] = []): Set<string> {
  const seen = new Set<string>();
  for (const id of models) { const m = /^(openai|anthropic|google|meta|mistral|deepseek|xai|qwen|moonshot)-/i.exec(id); if (m) seen.add(m[1].toLowerCase()); }
  return seen;
}
const LAB_PREFIX: Record<string, RegExp> = { openai: /^(gpt|o\d)/, anthropic: /^claude/, google: /^gem/, meta: /^(llama|muse)/, mistral: /^(mistral|ministral|devstral|codestral|magistral|pixtral)/, deepseek: /^deepseek/, xai: /^grok/, qwen: /^qwen/, moonshot: /^kimi/ };

// Case-insensitive dedupe, first spelling wins.
const dedupe = (ids: string[]): string[] => { const seen = new Set<string>(); return ids.filter((id) => { const k = String(id).toLowerCase(); if (!id || seen.has(k)) return false; seen.add(k); return true; }); };

// What to ask about when there's no /models: the matched provider's list first,
// then the latest generations from every lab (under the gateway's own prefixes).
// Capped: every id is one request per path.
export function candidateModels(base: string, catalog: CatalogInput = {}): { matched: MatchedProvider | null; ids: string[] } {
  const providers = Array.isArray(catalog) ? catalog : catalog.providers || [];
  const matched = matchCatalogProvider(base, providers);
  const recent = recentLabModels((catalog as Partial<EndpointCatalog>).labs || []);
  const prefixes = vendorPrefixes(matched?.models);
  const prefixed = recent.flatMap((id) => [...prefixes].filter((p) => LAB_PREFIX[p]?.test(id)).map((p) => `${p}-${id}`));
  const own = dedupe(dropSnapshots((matched?.models || []).filter((id) => !NON_CHAT_ID_RE.test(id))));
  const rest = dedupe(dropSnapshots([...own, ...prefixed, ...recent])).slice(own.length);
  const ids = dedupe([...own.slice(0, MAX_MATCHED_CANDIDATES), ...rest]).slice(0, Math.max(MAX_CANDIDATES, Math.min(own.length, MAX_MATCHED_CANDIDATES)));
  return { matched, ids };
}

// ---- Reading responses -------------------------------------------------------

// Error-body fragments that mean "your request reached a real model endpoint".
const UNKNOWN_MODEL_RE = /unknown model|model[^"]{0,40}(not found|does not exist|not supported|invalid|is not available|not available)|model\s+[\\]?["'`][^"'`]{1,100}[\\]?["'`]\s+(not found|does not exist|is not available)|no such model|invalid model|model_not_found|无可用渠道/i;
// Known to the endpoint but not usable here.
// Snowflake Cortex: "not eligible for this model" (account tier), "Model ... is unavailable".
const NOT_SERVABLE_RE = /legacy|does not support this endpoint|deprecated model|not eligible for this model|model\b.{0,120}?\bis unavailable/i;
const CLIENT_GATE_RE = /unauthorized client|client (is )?not allowed|unsupported client/i;
// Auth complaints, including the ones sent as 400 (Gemini: API_KEY_INVALID).
const AUTH_MSG_RE = /unauthori[sz]ed|invalid[ _-](api[ _-]?)?key|api[ _-]?key[^"]{0,20}(not valid|invalid|expired|revoked|missing|required)|incorrect api key|API_KEY_INVALID|authentication|invalid[_ ]token|access token|permission[_ ]denied|forbidden/i;
const KEY_IN_400_RE = /API_KEY_INVALID|api key not valid|invalid[ _-]api[ _-]?key|incorrect api key|api key (expired|revoked)/i;
// A 401/403 about one model, not the key (LiteLLM: "key not allowed to access
// model", "no access to m2", "does not have access to model x").
const MODEL_ACCESS_RE = /not allowed to access (the )?model|(no|not have|without) access to (the )?model|(access|permission) (to|for) (use |access )?(the |this )?model|model[^"]{0,40}(access (is )?denied|not permitted|not allowed|no permission)|team not allowed to access/i;
const NO_ACCESS_TO_RE = (model: string) => new RegExp(`no access to [\\\\]?["'\`]?${escapeRe(model)}(?![\\w.:/-])`, "i");
// The model id appears in the body as a whole token.
const namesModel = (text: string, model: string) => model.length >= 2 && new RegExp(`(^|[^\\w.:/-])${escapeRe(model)}(?![\\w.:/-])`, "i").test(text);

const isHtml = (ct: string | null | undefined, text: string) => /text\/html/i.test(ct || "") || /^\s*<(!doctype|html|head|body)/i.test(text || "");
const htmlTitle = (text: string) => (/<title[^>]*>([^<]{1,120})/i.exec(text || "")?.[1] || "").trim();

// An error body an API wrote: anthropic {type:"error",error:{type}}, openai
// {error:{message}} / {error:"..."}, gemini [{error:{...}}], plain {message|detail}.
function apiErrorShape(json: unknown): ErrorShape | null {
  const j0: unknown = Array.isArray(json) ? json[0] : json;
  if (!j0 || typeof j0 !== "object") return null;
  const j = j0 as Json;
  const err = j.error as Json;
  if (j.type === "error" && j.error && typeof j.error === "object" && err.type) return "anthropic";
  if (j.error && typeof j.error === "object" && (err.message || err.code || err.type)) return "openai";
  if (typeof j.error === "string" && j.error) return "openai";
  if (typeof j.message === "string" || typeof j.detail === "string" || Array.isArray(j.detail) || Array.isArray(j.errors)) return "generic";
  return null;
}
// What an error says, without what changes per request: JSON is parsed, volatile
// fields (request ids, timestamps, the echoed model) dropped, and the error's
// message / type / code kept; ids, uuids and the asked-about model are masked in
// the text. Two requests rejected for the same reason get the same signature.
const VOLATILE_KEY_RE = /^(id|request_?id|requestid|trace_?id|traceid|span_?id|correlation_?id|x[-_]request[-_]id|created(_at)?|timestamp|time|date|ts|model|model_id|path|url|uri|instance|method)$/i;
function maskText(text: string, model?: string): string {
  let t = String(text);
  if (model) t = t.split(model).join("<model>");
  return t
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b(req|request|trace|msg|chatcmpl|resp)[_-][A-Za-z0-9]{6,}\b/g, "<id>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, "<time>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b\d{9,}\b/g, "<n>")
    .replace(/\/10router-no-such-path|\/(chat\/completions|messages|responses)\b/g, "<path>")
    .replace(/\s+/g, " ").trim();
}
function stripVolatile(v: unknown, model?: string): unknown {
  if (Array.isArray(v)) return v.map((x) => stripVolatile(x, model));
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const k of Object.keys(v).sort()) if (!VOLATILE_KEY_RE.test(k)) out[k] = stripVolatile((v as Json)[k], model);
    return out;
  }
  return typeof v === "string" ? maskText(v, model) : v;
}
export function errorSignature(r: Pick<ProbeResult, "status" | "text" | "json">, model?: string): string {
  const j0: unknown = Array.isArray(r.json) ? r.json[0] : r.json;
  if (j0 && typeof j0 === "object") {
    const j = j0 as Json;
    const err = j.error && typeof j.error === "object" ? j.error as Json : null;
    const core = err ? { message: err.message, type: err.type, code: err.code, status: err.status }
      : { error: j.error, message: j.message, detail: j.detail, type: j.type, code: j.code, errors: j.errors };
    return `${r.status} ${JSON.stringify(stripVolatile(core, model))}`;
  }
  return `${r.status} ${maskText(r.text, model)}`;
}

// A 404 that means "no such route" rather than "no such model".
function isRouteMissing(r: ProbeResult): boolean {
  if (r.status === 405) return true;
  if (r.status !== 404) return false;
  if (UNKNOWN_MODEL_RE.test(r.text)) return false;
  if (r.step.html || !r.json) return true;
  const j = r.json as Json | null;
  const msg = String(j?.detail ?? (j?.error as Json | null | undefined)?.message ?? j?.error ?? j?.message ?? "").trim();
  return !msg || /^(404[: ]*)?(not found|page not found|route .* not found|no route|cannot (post|get) .*|invalid url.*)\.?$/i.test(msg);
}
const isStream = (r: ProbeResult) => /text\/event-stream|application\/x-ndjson/i.test(r.contentType || "") || /^\s*(data|event):/.test(r.text || "");
// A 2xx carrying generated output: the empty body didn't stop it. Streams count
// too: a 2xx stream is a model running, whatever the first event says.
const generated = (r: ProbeResult): boolean => r.status >= 200 && r.status < 300 && !r.step.html && (isStream(r) || (!!r.json
  && (Array.isArray((r.json as Json).choices) || Array.isArray((r.json as Json).content) || Array.isArray((r.json as Json).output) || (r.json as Json).type === "message" || (r.json as Json).object === "response")));
// A 2xx whose body is an error object (some gateways answer errors with 200).
const errorIn2xx = (r: ProbeResult): boolean => {
  const j = (Array.isArray(r.json) ? r.json[0] : r.json) as Json | null;
  return !!j && typeof j === "object" && (j.error !== undefined && j.error !== null && j.error !== false || j.type === "error" || j.success === false);
};

// A 401/403 that refuses one model rather than the key: it says so, or (on a
// model probe) it names the model it was asked about.
const explicitModelDenial = (r: ProbeResult, model: string) => MODEL_ACCESS_RE.test(r.text) || NO_ACCESS_TO_RE(model).test(r.text);
function modelDenied(r: ProbeResult, model: string, modelProbe: boolean): boolean {
  if (explicitModelDenial(r, model)) return true;
  return modelProbe && namesModel(r.text, model) && !KEY_IN_400_RE.test(r.text);
}

// One label per response, so every caller reads statuses the same way.
// `model`: the id the request asked about, so a 401/403 that refuses only that
// model reads as "model-denied". `modelProbe`: any non-error 2xx means a model ran.
export function classify(r: ProbeResult, { model, modelProbe = false }: { model?: string; modelProbe?: boolean } = {}): Classification {
  if (r.status === 0) return "network";
  if (r.status === 429) return "rate";
  if (r.status >= 500) return "server";
  if (r.status >= 200 && r.status < 300) {
    if (r.step.html) return "html";
    if (generated(r) || (modelProbe && !errorIn2xx(r))) return "generated";
    return "ok";
  }
  if (r.status === 401 || r.status === 403) {
    if (r.step.html) return "html";
    if (CLIENT_GATE_RE.test(r.text)) return "gated";
    if (model && modelDenied(r, model, modelProbe)) return "model-denied";
    return apiErrorShape(r.json) || AUTH_MSG_RE.test(r.text) || r.status === 401 ? "auth" : "other";
  }
  if (r.step.html) return isRouteMissing(r) ? "missing" : "html";
  if (isRouteMissing(r)) return "missing";
  if ((r.status === 400 || r.status === 422) && KEY_IN_400_RE.test(r.text)) return "auth";
  if (UNKNOWN_MODEL_RE.test(r.text)) return "unknown-model";
  if ((r.status === 400 || r.status === 422) && apiErrorShape(r.json) && !AUTH_MSG_RE.test(r.text)) return "accepted";
  return "other";
}

const ANTHROPIC = { "anthropic-version": "2023-06-01" };

function authHeaders(key: string): AuthHeaders {
  return {
    bearer: key ? { authorization: `Bearer ${key}` } : {},
    "x-api-key": key ? { "x-api-key": key } : {},
    "api-key": key ? { "api-key": key } : {},
    both: key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {},
  };
}

// Empty-body requests: a real API rejects them with 400 before running a model.
// Each still carries the smallest output cap the API allows (Responses: 16).
function probeSpecs(AUTH: AuthHeaders, openaiAuth: HeaderMap = AUTH.bearer): Record<Protocol, ProbeSpec> {
  return {
    anthropic: { path: "/messages", label: "POST /messages (empty)", headers: { ...AUTH.both, ...ANTHROPIC }, body: { model: "probe", max_tokens: 1, messages: [] } },
    "openai-chat": { path: "/chat/completions", label: "POST /chat/completions (empty)", headers: openaiAuth, body: { model: "probe", messages: [], max_tokens: 1, stream: false } },
    "openai-responses": { path: "/responses", label: "POST /responses (empty)", headers: openaiAuth, body: { model: "probe", input: [], max_output_tokens: 16, stream: false } },
  };
}

// Records every request as a step (status + body preview, secrets redacted).
// Retries 429s a few times, honouring Retry-After (capped). Every fetch gets the
// per-probe timeout combined with the caller's signal, so a client that hangs up
// stops the probing; past `deadlineAt` (or once aborted) no request is sent and
// the probe comes back `skipped` with status 0.
interface ProberArgs { fetchFn: DetectFetch; key: string; steps: DetectStep[]; timeoutMs: number; sleep?: Sleep; signal?: AbortSignal | null; deadlineAt?: number }
function makeProber({ fetchFn, key, steps, timeoutMs, sleep = defaultSleep, signal = null, deadlineAt = Infinity }: ProberArgs): Prober {
  const redact = makeRedactor(key);
  const halted = (): StopReason | null => signal?.aborted ? "aborted" : Date.now() >= deadlineAt ? "deadline" : null;
  const skipped = (label: string, method: string, target: string, why: StopReason): ProbeResult =>
    ({ status: 0, text: "", json: null, skipped: true, step: { label, method, url: redact(target), status: 0, preview: why === "aborted" ? "Cancelled" : "Skipped: out of time" } });
  const run = async (label: string, method: string, target: string, { headers = {}, body }: { headers?: HeaderMap; body?: Record<string, unknown> } = {}): Promise<ProbeResult> => {
    for (let attempt = 0; ; attempt++) {
      const why = halted();
      if (why) return skipped(label, method, target, why); // not recorded: nothing was sent
      // status is set below before the step is recorded.
      const step: Omit<DetectStep, "status"> & { status: number | null } = { label, method, url: redact(target), status: null, preview: "" };
      let res: ProbeResponse | null = null;
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now())));
      try {
        res = await fetchFn(target, {
          method,
          headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch (e) {
        const stop = halted();
        if (stop) return skipped(label, method, target, stop);
        step.status = 0;
        step.preview = redact((e as Error | null)?.message || String(e)).slice(0, BODY_PREVIEW);
        steps.push(step as DetectStep);
        return { status: 0, text: "", json: null, step: step as DetectStep };
      }
      const text = await res.text().catch(() => "");
      const contentType = res.headers?.get?.("content-type") ?? null;
      step.status = res.status;
      step.preview = redact(text).replace(/\s+/g, " ").slice(0, BODY_PREVIEW);
      step.html = isHtml(contentType, text);
      steps.push(step as DetectStep);
      if (res.status === 429 && attempt < MAX_RATE_RETRIES) {
        const ra = res.headers?.get?.("retry-after");
        const secs = ra && /^\d+(\.\d+)?$/.test(ra.trim()) ? +ra : ra ? (Date.parse(ra) - Date.now()) / 1000 : NaN;
        const wait = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 500 * 2 ** attempt;
        if (wait <= MAX_RETRY_WAIT_MS && Date.now() + wait < deadlineAt && !signal?.aborted) { step.retried = true; await sleep(wait); continue; }
      }
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, text, json, contentType, step: step as DetectStep };
    }
  };
  return Object.assign(run, { halted });
}

// Model probes carry only the model, the empty conversation and a 1-token cap,
// so the model name is the first thing validated. OpenAI-style gateways can
// reject max_tokens first (Snowflake: "deprecated in favor of
// max_completion_tokens"): then the cap moves to max_completion_tokens.
// stream:false stays explicit: a gateway that streams by default would otherwise
// answer with an SSE stream.
function modelBody(p: ProbeSpec, model: string, { maxCompletionTokens = false }: DetectQuirks = {}): Record<string, unknown> {
  const { max_tokens: _cap, ...rest } = p.body;
  if (p.path === "/chat/completions") return maxCompletionTokens ? { ...rest, model, max_completion_tokens: 1, stream: false } : { ...rest, model, max_tokens: 1, stream: false };
  return { ...p.body, model };
}
const MAX_COMPLETION_RE = /max_completion_tokens/i;

const PARTIAL_REASON: Record<StopReason, string> = {
  auth: "The key was rejected part-way through, so some models weren't checked.",
  denied: "The key isn't allowed to use any of the models checked.",
  rate: "The endpoint kept rate-limiting, so some models weren't checked.",
  generated: "The endpoint ran a model on an empty request, so model checks were stopped to avoid charges.",
  failing: "The endpoint kept failing (network errors, timeouts or 5xx), so some models weren't checked.",
  deadline: "Detection ran out of time, so some models weren't checked.",
  aborted: "Detection was cancelled, so some models weren't checked.",
};

// Tracks network/timeout/5xx failures in a row on one path.
function failureCounter() {
  let run = 0;
  return (k: Classification): boolean => { run = k === "network" || k === "server" ? run + 1 : 0; return run >= MAX_CONSECUTIVE_FAILURES; };
}
// Tracks model-access refusals by signature (the refusal with the model id
// taken out, so "no access to m1" and "no access to m2" match). Returns how many
// different models got this same refusal.
function deniedCounter() {
  const seen = new Map<string, Set<string>>();
  let most = 0;
  const count = (r: ProbeResult, model: string): number => {
    const sig = errorSignature(r, model);
    if (!seen.has(sig)) seen.set(sig, new Set());
    const models = seen.get(sig)!;
    models.add(model.toLowerCase());
    most = Math.max(most, models.size);
    return models.size;
  };
  return Object.assign(count, { most: () => most });
}

// Ask about each id with an empty body. Returns { ids, complete, stopped }:
// `ids` null when the endpoint doesn't validate model names first (then probing
// tells us nothing). `complete` is false when a probe failed (network error,
// 429, 5xx) so a missing id may just mean "couldn't ask"; `stopped` names why
// probing ended early (auth | rate | generated).
interface ProbeModelsArgs { probe: Prober; base: string; protocol: string; AUTH: AuthHeaders; openaiAuth: HeaderMap; ids: string[]; quirks?: DetectQuirks }
async function probeModels({ probe, base, protocol, AUTH, openaiAuth, ids, quirks = {} }: ProbeModelsArgs): Promise<{ ids: string[] | null; complete: boolean; stopped: StopReason | null }> {
  const out: { ids: string[] | null; complete: boolean; stopped: StopReason | null } = { ids: null, complete: false, stopped: null };
  const p = (probeSpecs(AUTH, openaiAuth) as Partial<Record<string, ProbeSpec>>)[protocol];
  if (!p || !ids.length) return out;
  const url = joinUrl(base, p.path);
  // Canary: a made-up id must be refused as unknown, or "accepted" means nothing.
  let canary = await probe("Check model (made-up id)", "POST", url, { headers: p.headers, body: modelBody(p, CANARY, quirks) });
  if (p.path === "/chat/completions" && !quirks.maxCompletionTokens && canary.status === 400 && MAX_COMPLETION_RE.test(canary.text)) {
    quirks.maxCompletionTokens = true;
    canary = await probe("Check model (made-up id, max_completion_tokens)", "POST", url, { headers: p.headers, body: modelBody(p, CANARY, quirks) });
  }
  if (canary.skipped) { out.stopped = probe.halted(); return out; }
  const ck = classify(canary, { model: CANARY, modelProbe: true });
  if (ck === "auth") { out.stopped = "auth"; return out; }
  if (ck === "rate") { out.stopped = "rate"; return out; }
  if (ck === "generated") { out.stopped = "generated"; out.ids = []; quirks.generatesOnEmpty = true; return out; }
  // A made-up id refused as "no access to that model" works as well (LiteLLM).
  if (ck !== "unknown-model" && ck !== "model-denied") return { ...out, complete: ck !== "network" && ck !== "server" };
  const ok: string[] = [];
  let failed = false;
  const failing = failureCounter();
  const denied = deniedCounter();
  const queue = dedupe(ids);
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, async () => {
    for (let id: string | undefined; !out.stopped && (id = queue.shift()) !== undefined;) {
      const r = await probe(`Check model ${id}`, "POST", url, { headers: p.headers, body: modelBody(p, id, quirks) });
      if (r.skipped) { out.stopped ||= probe.halted(); break; }
      const k = classify(r, { model: id, modelProbe: true });
      if (failing(k)) out.stopped ||= "failing";
      // That model isn't served to this key: mark it and go on. A generic 401/403
      // that merely names the model is weaker evidence, so the same one on
      // several models (with none accepted) is the key. An explicit "not allowed
      // to access model" never stops early: a restricted key (LiteLLM) gets it
      // for every model but the few it may use.
      if (k === "model-denied") { if (denied(r, id) >= MODEL_DENIED_STOP && !ok.length && !explicitModelDenial(r, id)) out.stopped ||= "auth"; }
      else if (k === "auth" || k === "gated") out.stopped ||= "auth";           // not "not served"
      else if (k === "rate") out.stopped ||= "rate";
      else if (k === "generated") { ok.push(id); quirks.generatesOnEmpty = true; out.stopped ||= "generated"; } // served, but stop spending
      else if (k === "network" || k === "server" || k === "html") failed = true;
      else if (k === "accepted" && !NOT_SERVABLE_RE.test(r.text)) ok.push(id);
    }
  }));
  // Every model asked about was refused alike: the key can't use any of them.
  if (!out.stopped && !ok.length && denied.most() >= MODEL_DENIED_STOP) out.stopped = "denied";
  out.complete = !failed && !out.stopped;
  // Keep catalog order, not completion order.
  const order = new Map(ids.map((id, i) => [id, i]));
  out.ids = ok.sort((a, b) => order.get(a)! - order.get(b)!);
  return out;
}

// GET /models with pagination. Returns { ids, listed, auth } where `listed`
// means a real list answered (even an empty one).
async function fetchModelList(probe: Prober, base: string, label: string, headers: HeaderMap): Promise<{ ids: string[]; listed: boolean; first: ProbeResult }> {
  let url: string | null = joinUrl(base, "/models");
  const ids: string[] = [];
  let first: ProbeResult | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES && url; page++) {
    const r = await probe(page ? `${label} page ${page + 1}` : label, "GET", url, { headers });
    if (!first) first = r;
    if (!(r.status >= 200 && r.status < 300) || r.step.html || !modelEntries(r.json)) break;
    ids.push(...parseModelList(r.json));
    url = nextModelPage(r.json, url);
  }
  const listed = !!first && first.status >= 200 && first.status < 300 && !first.step.html && !!modelEntries(first.json);
  // The loop always runs at least once, so `first` is set.
  return { ids: dedupe(ids), listed, first: first as ProbeResult };
}

// Which API path a model should use when the endpoint serves it on several.
// Claude stays on Anthropic Messages (thinking, tool_use and cache_control pass
// through untranslated); everything else prefers Responses, then Chat.
export function chooseRoute<P extends string>(model: string, protocols: P[]): P {
  if (protocols.length === 1) return protocols[0];
  const has = (p: string): p is P => (protocols as string[]).includes(p);
  if (/claude/i.test(model) && has("anthropic")) return "anthropic" as P;
  return ["openai-responses", "openai-chat", "anthropic"].find(has) || protocols[0];
}

// model -> route, from { protocol: [models] }. `primary` = the protocol serving
// the most models (the node's own type); routes only list models that leave it.
export function buildRoutes<P extends string>(byProtocol: Partial<Record<P, string[]>>, fixedPrimary: P | null = null): { primary: P | null; models: string[]; routes: Record<string, P>; counts: Record<string, number> } {
  const serving = new Map<string, P[]>();
  for (const [proto, ids] of Object.entries(byProtocol) as [P, string[] | undefined][]) for (const id of ids || []) {
    if (!serving.has(id)) serving.set(id, []);
    serving.get(id)!.push(proto);
  }
  const all: Record<string, P> = {};
  for (const [id, protos] of serving) all[id] = chooseRoute(id, protos);
  const counts: Record<string, number> = {};
  for (const p of Object.values(all)) counts[p] = (counts[p] || 0) + 1;
  const primary = fixedPrimary || (Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a === "anthropic" ? -1 : 1))[0] as P | undefined) || null;
  const routes = Object.fromEntries(Object.entries(all).filter(([, p]) => p !== primary));
  return { primary, models: [...serving.keys()], routes, counts };
}

// Models for an already-known endpoint (the "Import models" button): /models
// first, then the catalog probe. Free requests only.
// Adds `partial` + `partialReason` when probing stopped early, and
// `authRejected` when the key was refused.
export interface DiscoverOptions {
  baseUrl?: string | null;
  apiKey?: unknown;
  protocol: string;
  protocols?: string[];
  fetchFn: DetectFetch;
  catalog?: CatalogInput;
  timeoutMs?: number;
  quirks?: DetectQuirks;
  sleep?: Sleep;
  // Client hang-up: stops probing. deadlineMs: the whole run's time budget.
  signal?: AbortSignal | null;
  deadlineMs?: number;
  deadlineAt?: number;
}
export async function discoverModels({ baseUrl, apiKey, protocol, protocols, fetchFn, catalog = {}, timeoutMs = PROBE_TIMEOUT_MS, quirks = {}, sleep, signal = null, deadlineMs = DETECT_DEADLINE_MS, deadlineAt = Date.now() + deadlineMs }: DiscoverOptions): Promise<DiscoverResult> {
  // Two-path endpoint: discover on each path, then route each model.
  if (protocols && protocols.length > 1) {
    const steps: DetectStep[] = [];
    const byProtocol: Record<string, string[]> = {};
    const complete: Record<string, boolean> = {};
    let source: ModelsSource = "none", catalogName: string | undefined, partialReason: string | null = null, authRejected = false;
    for (const p of protocols) {
      const r = await discoverModels({ baseUrl, apiKey, protocol: p, fetchFn, catalog, timeoutMs, quirks, sleep, signal, deadlineAt });
      steps.push(...r.steps);
      byProtocol[p] = r.models;
      complete[p] = r.complete as boolean; // single-path result
      partialReason ||= r.partialReason;
      authRejected ||= r.authRejected;
      if (r.models.length && source === "none") { source = r.source; catalogName = r.catalogName; }
      if (r.authRejected) break; // same key on every path
      if (signal?.aborted || Date.now() >= deadlineAt) { partialReason ||= PARTIAL_REASON[signal?.aborted ? "aborted" : "deadline"]; break; }
    }
    for (const p of protocols) if (!(p in complete)) { complete[p] = false; byProtocol[p] = []; }
    // The node's own path is fixed here (it's already saved), so route against it.
    const { models, routes, counts } = buildRoutes(byProtocol, protocol);
    // Routes are only trustworthy when every path was asked about every model.
    const allComplete = protocols.every((p) => complete[p]);
    return { models, source, catalogName, steps, routes, counts, byProtocol, complete, allComplete, partial: !!partialReason, partialReason, authRejected };
  }
  const key = cleanKey(apiKey);
  const base = String(baseUrl || "").replace(/\/+$/, "").replace(/\/messages$/, "");
  const steps: DetectStep[] = [];
  const probe = makeProber({ fetchFn, key, steps, timeoutMs, sleep, signal, deadlineAt });
  const AUTH = authHeaders(key);
  const azure = isAzureHost(base);
  const openaiAuth = azure ? AUTH["api-key"] : AUTH.bearer;
  const styles: [string, HeaderMap][] = protocol === "anthropic" ? [["x-api-key", { ...AUTH.both, ...ANTHROPIC }]] : [[azure ? "api-key" : "bearer", openaiAuth]];
  let sawAuth = false;
  for (const [style, h] of [["none", {}], ...styles] as [string, HeaderMap][]) {
    const r = await fetchModelList(probe, base, `GET /models (${style === "none" ? "no auth" : style})`, h);
    if (r.ids.length) return { models: r.ids, source: "models", steps, complete: true, partial: false, partialReason: null, authRejected: false };
    const k = classify(r.first);
    if (style !== "none" && (k === "auth" || k === "gated")) sawAuth = true;
    if (k === "missing" || k === "network") break;
  }
  const { matched, ids } = candidateModels(base, catalog);
  const res = await probeModels({ probe, base, protocol, AUTH, openaiAuth, ids, quirks });
  // A /models 401 alone isn't a refused key when the model probes got through
  // (the canary was validated, or the endpoint answered without checking).
  const authRejected = keyStop(res.stopped) || (sawAuth && res.ids === null && !res.complete && !res.stopped);
  const halted = res.stopped ? null : probe.halted();
  const partialReason = res.stopped ? PARTIAL_REASON[res.stopped] : authRejected ? PARTIAL_REASON.auth : halted ? PARTIAL_REASON[halted] : null;
  const meta = { steps, complete: res.complete && !authRejected && !halted, partial: !!partialReason, partialReason, authRejected };
  if (res.ids?.length) return { models: res.ids, source: matched ? "catalog" : "guessed", catalogName: matched?.name, ...meta };
  return { models: [], source: "none", ...meta };
}

// Probe runner. `fetchFn` is injected so tests (and the SSRF-safe fetch) can supply it.
export interface DetectOptions {
  url: unknown;
  apiKey?: unknown;
  fetchFn: DetectFetch;
  catalog?: CatalogInput;
  timeoutMs?: number;
  sleep?: Sleep;
  // Client hang-up: stops probing. deadlineMs: the whole detection's time budget.
  signal?: AbortSignal | null;
  deadlineMs?: number;
}
export async function detectEndpoint({ url, apiKey, fetchFn, catalog = {}, timeoutMs = PROBE_TIMEOUT_MS, sleep, signal = null, deadlineMs = DETECT_DEADLINE_MS }: DetectOptions): Promise<DetectResult> {
  const key = cleanKey(apiKey);
  const base0 = normalizeUrl(url);
  const steps: DetectStep[] = [];
  if (!base0) return { ok: false, error: "That doesn't look like a URL.", steps };

  const deadlineAt = Date.now() + deadlineMs;
  const probe = makeProber({ fetchFn, key, steps, timeoutMs, sleep, signal, deadlineAt });
  const AUTH = authHeaders(key);
  const azure = isAzureHost(base0);

  let models: string[] = [];
  let base = base0;
  let modelsAuth: string | null = null;
  let sawAuthFail = false;
  const listRefused = new Set<string>(); // auth styles GET /models refused
  let clientGated = false;
  let rateLimited = false;
  const note = (k: Classification) => {
    if (k === "auth") sawAuthFail = true;
    if (k === "gated") clientGated = true;
    if (k === "rate") rateLimited = true;
  };

  // 1. Model list: no auth, then each auth style, on each candidate base.
  const listStyles: [string, HeaderMap][] = [["none", {}], ...(azure ? [["api-key", AUTH["api-key"]] as [string, HeaderMap]] : []), ["bearer", AUTH.bearer], ["x-api-key", { ...AUTH["x-api-key"], ...ANTHROPIC }], ...(azure ? [] : [["api-key", AUTH["api-key"]] as [string, HeaderMap]])];
  outer:
  for (const b of candidateBases(base0)) {
    for (const [style, h] of listStyles) {
      if (style !== "none" && !key) continue;
      // api-key is only a fallback after Bearer was refused (Azure-style).
      if (style === "api-key" && !azure && !sawAuthFail) continue;
      const r = await fetchModelList(probe, b, `GET /models (${style === "none" ? "no auth" : style})`, h);
      if (r.listed && (r.ids.length || Array.isArray((r.first.json as Json | null)?.data))) { models = r.ids; base = b; modelsAuth = style; break outer; }
      const k = classify(r.first);
      if (style !== "none") note(k); else if (k === "gated") clientGated = true;
      if (style !== "none" && k === "auth") listRefused.add(style);
      if (k === "missing" || k === "network") break; // nothing at this path for any auth
    }
  }
  const openaiAuth = modelsAuth === "api-key" || (azure && modelsAuth !== "bearer") ? AUTH["api-key"] : AUTH.bearer;
  const PROBES = probeSpecs(AUTH, openaiAuth);

  // 2. Protocol: empty-body probes. Anthropic first when the host/key hints at it.
  // Found = an API-shaped 400/422 (or an unknown-model error, vLLM/Ollama answer
  // that with 404). 5xx, HTML, plain "Not Found" and auth errors are not.
  const preferAnthropic = /anthropic|claude|cortex|snowflake/i.test(base0) || /^sk-ant-/.test(key);
  const order: Protocol[] = preferAnthropic ? ["anthropic", "openai-chat", "openai-responses"] : ["openai-chat", "openai-responses", "anthropic"];
  // A model-access 401/403 on model "probe" counts too: the path and key work.
  const found: { proto: Protocol; base: string; shape: ErrorShape | null; sig: string }[] = [];
  const generatesOnEmpty = new Set<Protocol>();
  let serverErrors = 0;
  for (const b of models.length ? [base] : candidateBases(base0)) {
    for (const proto of order) {
      const p = PROBES[proto];
      const r = await probe(p.label, "POST", joinUrl(b, p.path), { headers: p.headers, body: p.body });
      if (r.skipped) break;
      const k = classify(r, { model: String(p.body.model) });
      note(k);
      if (k === "server") serverErrors++;
      if (k === "accepted" || k === "unknown-model" || k === "model-denied") found.push({ proto, base: b, shape: apiErrorShape(r.json), sig: errorSignature(r, String(p.body.model)) });
      else if (k === "generated") { found.push({ proto, base: b, shape: null, sig: "" }); generatesOnEmpty.add(proto); }
    }
    if (found.length || probe.halted()) { if (found.length) base = found[0].base; break; }
  }

  // A server that answers every path alike (a catch-all 400) isn't evidence of
  // any protocol: send the same request (same model, same auth) to a path no API
  // has. If it gets the same kind of answer, keep only paths whose error is shaped
  // like their own protocol and says something other than the catch-all.
  // Bodies are compared normalized, so an echoed request id doesn't tell them apart.
  let filtered = found;
  if (found.length) {
    const controls = new Map<string, { sig: string; catchAll: boolean } | null>();
    for (const f of found) {
      if (!f.sig) continue; // generated: nothing to compare
      const p = PROBES[f.proto];
      const ctlKey = JSON.stringify([p.headers, p.body]);
      if (controls.has(ctlKey)) continue;
      const ctl = await probe(`Control (made-up path, as ${f.proto})`, "POST", joinUrl(base, CONTROL_PATH), { headers: p.headers, body: p.body });
      if (ctl.skipped) { controls.set(ctlKey, null); continue; }
      const ck = classify(ctl, { model: String(p.body.model) });
      controls.set(ctlKey, { sig: errorSignature(ctl, String(p.body.model)), catchAll: ck === "accepted" || ck === "unknown-model" || ck === "model-denied" });
    }
    filtered = found.filter((f) => {
      const p = PROBES[f.proto];
      const ctl = f.sig ? controls.get(JSON.stringify([p.headers, p.body])) : null;
      if (!ctl?.catchAll) return true;
      return f.sig !== ctl.sig && (f.proto === "anthropic" ? f.shape === "anthropic" : f.shape === "openai");
    });
  }

  // The key worked with some auth style, so a refusal of another style isn't a refused key.
  const keyAccepted = !!modelsAuth && modelsAuth !== "none";
  const stop0 = probe.halted();
  if (!filtered.length && stop0) {
    return { ok: false, error: stop0 === "aborted" ? "Detection was cancelled." : "Detection ran out of time before an API answered. Try again.", baseUrl: base0, steps, partial: true, partialReason: PARTIAL_REASON[stop0], clientGated, authRejected: false, rateLimited };
  }

  if (!filtered.length) {
    const last = steps[steps.length - 1];
    const html = steps.find((s) => s.html);
    const error = clientGated ? "This endpoint only accepts specific clients."
      : sawAuthFail && !keyAccepted ? "The key was rejected."
      : rateLimited ? "The endpoint is rate-limiting requests. Try again in a minute."
      : found.length ? "This server answers every request the same way, so no API could be identified."
      : serverErrors ? "The endpoint returned server errors (5xx). It may be down; try again later."
      : html ? `This isn't an API response${htmlTitle(html.preview) ? ` (got "${htmlTitle(html.preview)}")` : ""}.`
      : last?.status === 0 ? `Couldn't reach it: ${last.preview}`
      : "No OpenAI or Anthropic API found at this URL.";
    return { ok: false, error, baseUrl: base0, steps, clientGated, authRejected: sawAuthFail && !keyAccepted && !clientGated, rateLimited };
  }

  const protocol = filtered[0].proto;
  // Quirks we can read off the free probes' error bodies.
  const quirks: DetectQuirks = {};
  if (steps.some((st) => /chat\/completions/.test(st.url) && MAX_COMPLETION_RE.test(st.preview))) quirks.maxCompletionTokens = true;
  if (generatesOnEmpty.size) quirks.generatesOnEmpty = true; // model probes may set it too
  if (openaiAuth === AUTH["api-key"] && key) quirks.apiKeyHeader = true;
  const protocols = [...new Set(filtered.map((f) => f.proto))];

  // 3. Is the key really checked? A bad key must be refused, or "works" means nothing.
  let keyConfirmed: KeyConfirmed = modelsAuth && modelsAuth !== "none" ? "likely" : "unknown";
  if (key && !generatesOnEmpty.has(protocol)) {
    const p = PROBES[protocol];
    const bad = "10router-bad-key-check";
    const badHeaders = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, k === "authorization" ? `Bearer ${bad}` : k === "x-api-key" || k === "api-key" ? bad : v]));
    const r = await probe("Bad-key check", "POST", joinUrl(base, p.path), { headers: badHeaders, body: p.body });
    const k = classify(r);
    if (!r.skipped) keyConfirmed = k === "auth" ? "confirmed" : r.status === 400 ? "unknown" : keyConfirmed;
  }

  // 4. No list? Ask about candidate models one at a time, still free. When
  // several APIs answered, ask on each: they can serve different models.
  let modelsSource: ModelsSource = models.length ? "models" : "none";
  const { matched, ids: candidates } = candidateModels(base, catalog);
  let routes: Record<string, Protocol> = {};
  let byProtocol: Partial<Record<Protocol, string[]>> | null = null;
  let primary: Protocol = protocol;
  let partialReason: string | null = null;
  // Only a model-probe refusal counts as a refused key here: the protocol probes
  // already got through with the key, and a /models refusal of one auth style
  // says nothing about the style that worked.
  let probesRefusedKey = false;
  if (!models.length) {
    byProtocol = {};
    for (const proto of protocols) {
      if (generatesOnEmpty.has(proto)) { byProtocol[proto] = []; partialReason ||= PARTIAL_REASON.generated; continue; }
      const res = await probeModels({ probe, base, protocol: proto, AUTH, openaiAuth, ids: candidates, quirks });
      byProtocol[proto] = res.ids || [];
      if (res.stopped) { partialReason ||= PARTIAL_REASON[res.stopped]; if (keyStop(res.stopped)) probesRefusedKey = true; }
      if (res.stopped && res.stopped !== "generated" && res.stopped !== "failing") break; // same key / limiter / clock on every path
    }
    const built = buildRoutes(byProtocol);
    if (built.models.length) {
      models = built.models;
      routes = built.routes;
      primary = built.primary as Protocol; // set: there are models
      modelsSource = matched ? "catalog" : "guessed";
    }
  }
  const stop1 = probe.halted();
  if (stop1) partialReason ||= PARTIAL_REASON[stop1];
  // The probes passed, but the key was refused while asking about models
  // (revoked key on an endpoint with no /models): say so, not "no list".
  // GET /models refusing the very style the found path uses still counts, unless
  // the bad-key check showed the path checks keys (then the real one passed).
  const pathStyle = primary === "anthropic" ? ["bearer", "x-api-key"] : [openaiAuth === AUTH["api-key"] ? "api-key" : "bearer"];
  const listRefusedPathStyle = pathStyle.every((st) => listRefused.has(st)) && keyConfirmed !== "confirmed";
  const authRejected = !models.length && !keyAccepted && (probesRefusedKey || listRefusedPathStyle);

  const name = matched?.name || suggestName(base);
  return {
    ok: true,
    protocol: primary,
    protocols,
    routes,
    byProtocol,
    baseUrl: base,
    models,
    modelsSource,
    keyConfirmed,
    quirks,
    partial: !!partialReason,
    partialReason,
    authRejected,
    suggestedName: name,
    suggestedPrefix: makePrefix(name),
    steps,
  };
}
