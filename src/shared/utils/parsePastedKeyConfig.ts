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
  // How many variables were neither the key nor the URL.
  ignored: number;
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

const VERSION_SUFFIX = /\/v\d+(beta)?$/i;
const ENV_LINE = /^(?:export\s+|set\s+|\$env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseJsonLoose(text: string): unknown {
  for (const t of [text, text.replace(/,(\s*[}\]])/g, "$1")]) {
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

function unquote(raw: string): string {
  const v = raw.trim();
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(v);
  if (dq) return dq[1].replace(/\\(["\\$`])/g, "$1");
  const sq = /^'([^']*)'/.exec(v);
  if (sq) return sq[1];
  return v.replace(/\s+#.*$/, "");
}

function envFromLines(text: string): Env | null {
  const out: Env = {};
  let any = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = ENV_LINE.exec(line);
    if (!m) return null;
    out[m[1]] = unquote(m[2]);
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
// give the key its own URL (custom endpoints only). Returns null when the text
// isn't a config naming a key or URL.
export function parsePastedKeyConfig(
  text: unknown,
  { endpointUrl = "", keyUrl = true }: { endpointUrl?: string | null; keyUrl?: boolean } = {},
): PastedKeyConfig | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const env = t.startsWith("{") || t.startsWith('"') ? envFromJson(t) : envFromLines(t);
  if (!env) return null;

  const keyVar = KEY_VARS.find((k) => env[k]?.trim());
  const family = keyVar?.startsWith("OPENAI_") ? "OPENAI_" : "ANTHROPIC_";
  const urlVars = keyUrl ? [...URL_VARS].sort((a, b) => Number(b.family === family) - Number(a.family === family)) : [];
  const urlVar = urlVars.find((u) => toEndpointUrl(env[u.name] || "", u.addVersion));
  if (!keyVar && !urlVar) return null;

  const rawUrl = urlVar ? env[urlVar.name] : "";
  const pastedUrl = urlVar ? toEndpointUrl(rawUrl, urlVar.addVersion) : "";
  const nodeUrl = endpointUrl ? canonicalUrl(endpointUrl) : "";
  const sameAsEndpoint = !!pastedUrl && !!nodeUrl && (pastedUrl === nodeUrl || canonicalUrl(rawUrl) === nodeUrl);
  const used = new Set([keyVar, urlVar?.name].filter(Boolean));
  return {
    apiKey: keyVar ? env[keyVar].trim() : "",
    baseUrl: sameAsEndpoint ? "" : pastedUrl,
    sameAsEndpoint,
    ignored: Object.keys(env).filter((k) => !used.has(k)).length,
  };
}

// The hint shown under the key field. Names what was filled, never a value.
// keptKey: the paste had no key and the field's existing key was left in place.
export function describePastedKeyConfig(
  { apiKey, baseUrl, sameAsEndpoint, ignored }: PastedKeyConfig,
  { keptKey = false }: { keptKey?: boolean } = {},
): string {
  const filled = [apiKey && "key", baseUrl && "endpoint URL"].filter(Boolean);
  const parts = [filled.length ? `Filled from pasted config: ${filled.join(", ")}.` : "Read the pasted config."];
  if (sameAsEndpoint) parts.push("Its URL is this endpoint's own, so the key uses that.");
  if (!apiKey) parts.push(keptKey ? "It has no key, so the key already entered stays." : "It has no key: paste the key here.");
  if (ignored) parts.push(`Ignored ${ignored} other variable${ignored === 1 ? "" : "s"}.`);
  return parts.join(" ");
}
