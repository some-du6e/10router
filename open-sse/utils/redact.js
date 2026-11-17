import {
  SENSITIVE_HEADER_PATTERN,
  SECRET_QUERY_PARAMS,
  CREDENTIAL_FIELDS,
  PROVIDER_DATA_CREDENTIAL_FIELDS,
  MIN_SECRET_VALUE_LENGTH,
  REDACTED,
} from "../config/redactionConstants.js";

export { REDACTED };

const SECRET_QUERY_PARAM_SET = new Set(SECRET_QUERY_PARAMS);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `?key=...` / `&token=...` inside free text, for when a URL can't be parsed.
// Group 1 is the `?name=` prefix.
export const SECRET_QUERY_PARAM_RE = new RegExp(`([?&](?:${SECRET_QUERY_PARAMS.map(escapeRe).join("|")})=)[^&#\\s"']*`, "gi");
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function isSensitiveHeader(name) {
  return typeof name === "string" && SENSITIVE_HEADER_PATTERN.test(name);
}

function headerEntries(headers) {
  if (!headers || typeof headers !== "object") return [];
  return typeof headers.entries === "function" && !Array.isArray(headers) ? [...headers.entries()] : Object.entries(headers);
}

// Request logs: keep enough of a credential (its last 4 characters) to tell
// two keys apart, never enough to use it.
export function maskSensitiveHeaders(headers) {
  const masked = {};
  for (const [name, value] of headerEntries(headers)) {
    if (!isSensitiveHeader(name) || value == null) {
      masked[name] = value;
      continue;
    }
    const text = String(value);
    masked[name] = text.length > 16 ? `***${text.slice(-4)}` : "***";
  }
  return masked;
}

// Header names stay, credential values read [REDACTED].
export function redactSensitiveHeaders(headers, placeholder = REDACTED) {
  return Object.fromEntries(headerEntries(headers).map(([name, value]) => [name, isSensitiveHeader(name) ? placeholder : value]));
}

// Credential headers removed entirely (persisted request details).
export function dropSensitiveHeaders(headers) {
  return Object.fromEntries(headerEntries(headers).filter(([name]) => !isSensitiveHeader(name)));
}

// Replaces the value of every secret query parameter in a URL.
export function redactUrlSecrets(url, placeholder = REDACTED) {
  if (typeof url !== "string" || !url.includes("?")) return url;
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_PARAM_SET.has(name.toLowerCase())) {
        parsed.searchParams.set(name, placeholder);
        changed = true;
      }
    }
    // searchParams percent-encodes the placeholder; show it as written.
    return changed ? parsed.toString().split(encodeURIComponent(placeholder)).join(placeholder) : url;
  } catch {
    return url.replace(SECRET_QUERY_PARAM_RE, `$1${placeholder}`);
  }
}

// The stored credential values of a connection (API key, OAuth tokens, Copilot token).
export function credentialSecrets(credentials) {
  if (!credentials || typeof credentials !== "object") return [];
  const values = [
    ...CREDENTIAL_FIELDS.map((field) => credentials[field]),
    ...PROVIDER_DATA_CREDENTIAL_FIELDS.map((field) => credentials.providerSpecificData?.[field]),
  ];
  return [...new Set(values.filter((v) => typeof v === "string" && v.length >= MIN_SECRET_VALUE_LENGTH))];
}

// A secret as it can appear in text: raw, JSON-escaped (quotes, backslashes and
// "/" -> "\/"), and URL-encoded. Longest first, so a form containing another is
// replaced whole.
function secretForms(secret) {
  const json = JSON.stringify(secret).slice(1, -1);
  const forms = [secret, json, json.replace(/\//g, "\\/"), secret.replace(/\//g, "\\/"), encodeURIComponent(secret)];
  return [...new Set(forms)].sort((a, b) => b.length - a.length);
}

/** Strips bearer tokens and the given credentials' values from text bound for clients or logs. */
export function sanitizeSecrets(text, credentials = null, placeholder = "[redacted]") {
  if (!text) return text;
  let out = String(text).replace(BEARER_RE, `Bearer ${placeholder}`);
  for (const secret of credentialSecrets(credentials)) {
    for (const form of secretForms(secret)) out = out.split(form).join(placeholder);
  }
  return out;
}
