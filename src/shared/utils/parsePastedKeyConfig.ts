// Reads a key (and endpoint URL) out of a config snippet pasted into an
// "API key" field: a Claude Code settings.json with "env", a bare env object,
// or KEY=value / export KEY="value" lines. Anything else returns null and the
// text is used as the key, as before. Pure, no node:* imports: the dashboard
// bundles this file.
import { normalizeEndpointUrl } from "./endpointUrl.js";

type Env = Record<string, string>;

export interface PastedKeyConfig {
  apiKey: string;
  // "" when there is none, or it is the endpoint's own URL (sameAsEndpoint).
  baseUrl: string;
  sameAsEndpoint: boolean;
  // How many variables were neither the key nor the URL (nor badUrl, nor
  // read for them through a reference).
  ignored: number;
  // The *_BASE_URL variable that would have set the URL but isn't an
  // http(s) URL, or "".
  badUrl: string;
}

const KEY_VARS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

// 10router endpoint URLs end at the API version (".../v1"), and the executor
// appends /messages or /chat/completions. Claude Code's ANTHROPIC_BASE_URL
// stops before it (Claude Code appends /v1/messages); OPENAI_BASE_URL includes
// it, like 10router's.
const URL_VARS = [
  { name: "ANTHROPIC_BASE_URL", family: "ANTHROPIC_", addVersion: true },
  { name: "OPENAI_BASE_URL", family: "OPENAI_", addVersion: false },
];

// $NAME, ${NAME}, %NAME% or $env:NAME as the whole value.
const VAR_REF = /^(?:\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%|\$env:([A-Za-z_]\w*))$/i;
const VERSION_SUFFIX = /\/v\d+(beta)?$/i;
const ENV_LINE = /^(?:(?:export|set)\s+|\$env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i;

// A doc or chat app may have turned the quotes typographic.
const asciiQuotes = (s: string) => s.replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2018\u2019]/g, "'");
const TYPOGRAPHIC_QUOTE = /^[\u201c\u201d\u201e\u2018\u2019]/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseJsonLoose(text: string): unknown {
  const forms = [text, asciiQuotes(text)].flatMap((t) => [t, t.replace(/,(\s*[}\]])/g, "$1")]);
  for (const t of forms) {
    try { return JSON.parse(t); } catch { /* try the next form */ }
  }
  return undefined;
}

function envFromJson(text: string): Env | null {
  // A bare `"env": { ... }` fragment copied out of settings.json is accepted too.
  const obj = parseJsonLoose(text.startsWith("{") ? text : `{${text.replace(/,\s*$/, "")}}`);
  if (!isPlainObject(obj)) return null;
  const env = isPlainObject(obj.env) ? obj.env : obj;
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  }
  return out;
}

// A shell one-liner (`A=x B=y claude`, `A=x && claude`) has more than the
// value after the "=", and so do lines an <input> ran together.
const RUN_ON = /\s|;|&&|\|\|/;
const OTHER_VAR = /(?:ANTHROPIC|OPENAI)_[A-Z0-9_]*=/;

// The value of a KEY=value line, or null when it isn't a single value.
function unquote(raw: string): string | null {
  const v = TYPOGRAPHIC_QUOTE.test(raw.trim()) ? asciiQuotes(raw.trim()) : raw.trim();
  const dq = /^"((?:[^"\\]|\\.)*)"(.*)$/.exec(v);
  const sq = /^'([^']*)'(.*)$/.exec(v);
  let value: string;
  if (dq || sq) {
    const [, inner, rest] = (dq || sq) as RegExpExecArray;
    if (rest && !/^\s+#/.test(rest)) return null;
    value = dq ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
  } else {
    value = v.replace(/\s+#.*$/, "");
    if (RUN_ON.test(value)) return null;
  }
  return OTHER_VAR.test(value) ? null : value;
}

function envFromLines(text: string): Env | null {
  const out: Env = {};
  let any = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = ENV_LINE.exec(line);
    const value = m ? unquote(m[2]) : null;
    if (!m || value == null) return null;
    out[m[1]] = value;
    any = true;
  }
  return any ? out : null;
}

// Trimmed, no trailing slash or pasted API path, host lowercased, hash dropped.
function canonicalUrl(raw: string): string {
  const s = normalizeEndpointUrl(raw);
  try {
    const u = new URL(s);
    u.hash = "";
    return normalizeEndpointUrl(u.href);
  } catch {
    return s;
  }
}

// The pasted URL in the form a 10router endpoint URL takes, or "" if it isn't
// an http(s) URL.
function toEndpointUrl(raw: string, addVersion: boolean): string {
  let u: URL;
  try { u = new URL(canonicalUrl(raw)); } catch { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const path = u.pathname.replace(/\/+$/, "");
  if (addVersion && !VERSION_SUFFIX.test(path)) u.pathname = `${path}/v1`;
  return normalizeEndpointUrl(u.href);
}

// endpointUrl: the endpoint's own base URL. keyUrl: whether this dialog can
// give the key its own URL (custom endpoints only). apiType: the endpoint's
// API, whose key (and, with no key, URL) wins when the paste has both. Returns null when the text
// isn't a config naming a key or URL.
export function parsePastedKeyConfig(
  text: unknown,
  { endpointUrl = "", keyUrl = true, apiType }: { endpointUrl?: string | null; keyUrl?: boolean; apiType?: "anthropic" | "openai" } = {},
): PastedKeyConfig | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const env = /^[{"\u201c\u201d]/.test(t) ? envFromJson(t) : envFromLines(t);
  if (!env) return null;
  // Provider docs set the key in its own variable and point ANTHROPIC_AUTH_TOKEN
  // at it. Read it from the paste; a key that names a variable the paste
  // doesn't set is no key, and a URL like that is left for badUrl.
  const refTo: Record<string, string> = {};
  const unsetKeyRefs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    const ref = VAR_REF.exec(v.trim());
    if (!ref) continue;
    const target = ref.slice(1).find(Boolean) as string;
    const value = env[target]?.trim() || "";
    if (target !== k && value && !VAR_REF.test(value)) {
      env[k] = value;
      refTo[k] = target;
    } else if (KEY_VARS.includes(k)) {
      env[k] = "";
      unsetKeyRefs.push(k);
    }
  }

  const keyVars = apiType === "openai" ? [...KEY_VARS].sort((a, b) => Number(b.startsWith("OPENAI_")) - Number(a.startsWith("OPENAI_"))) : KEY_VARS;
  const keyVar = keyVars.find((k) => env[k]?.trim());
  const family = keyVar ? (keyVar.startsWith("OPENAI_") ? "OPENAI_" : "ANTHROPIC_") : (apiType === "openai" ? "OPENAI_" : "ANTHROPIC_");
  const urlVars = keyUrl
    ? [...URL_VARS]
      .filter((u) => u.family === family || !KEY_VARS.some((k) => k.startsWith(u.family) && env[k]?.trim()))
      .sort((a, b) => Number(b.family === family) - Number(a.family === family))
    : [];
  const urlVar = urlVars.find((u) => toEndpointUrl(env[u.name] || "", u.addVersion));
  if (!keyVar && !urlVar && !unsetKeyRefs.length) return null;
  const badUrl = urlVar ? "" : urlVars.find((u) => env[u.name]?.trim())?.name || "";

  const rawUrl = urlVar ? env[urlVar.name] : "";
  const pastedUrl = urlVar ? toEndpointUrl(rawUrl, urlVar.addVersion) : "";
  const nodeUrl = endpointUrl ? canonicalUrl(endpointUrl) : "";
  const sameAsEndpoint = !!pastedUrl && !!nodeUrl && (pastedUrl === nodeUrl || canonicalUrl(rawUrl) === nodeUrl);
  const used = new Set([keyVar, urlVar?.name, badUrl, ...unsetKeyRefs].filter(Boolean));
  for (const k of [keyVar, urlVar?.name]) if (k && refTo[k]) used.add(refTo[k]);
  return {
    apiKey: keyVar ? env[keyVar].trim() : "",
    baseUrl: sameAsEndpoint ? "" : pastedUrl,
    sameAsEndpoint,
    ignored: Object.keys(env).filter((k) => !used.has(k)).length,
    badUrl,
  };
}

// The hint shown under the key field. Names what was filled, never a value.
// keptKey: the paste had no key and the field's existing key was left in place.
export function describePastedKeyConfig(
  { apiKey, baseUrl, sameAsEndpoint, ignored, badUrl }: PastedKeyConfig,
  { keptKey = false }: { keptKey?: boolean } = {},
): string {
  const filled = [apiKey && "key", baseUrl && "endpoint URL"].filter(Boolean);
  const parts = [filled.length ? `Filled from pasted config: ${filled.join(", ")}.` : "Read the pasted config."];
  if (sameAsEndpoint) parts.push("Its URL is this endpoint's own, so the key uses that.");
  if (badUrl) parts.push(`Its ${badUrl} isn't an http(s) URL, so the key uses this endpoint's.`);
  if (!apiKey) parts.push(keptKey ? "It has no key, so the key already entered stays." : "It has no key: paste the key here.");
  if (ignored) parts.push(`Ignored ${ignored} other variable${ignored === 1 ? "" : "s"}.`);
  return parts.join(" ");
}
