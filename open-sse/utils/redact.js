import {
  SENSITIVE_HEADER_PATTERN,
  NON_SECRET_HEADER_PATTERN,
  SECRET_QUERY_PARAMS,
  SECRET_QUERY_PARAM_NAME_PATTERN,
  BEARER_TOKEN_PATTERN,
  CREDENTIAL_FIELDS,
  PROVIDER_DATA_SECRET_NAME_PATTERN,
  MIN_SECRET_VALUE_LENGTH,
  REDACTED,
  REDACTED_TEXT,
} from "../config/redactionConstants.js";

export { REDACTED, SECRET_QUERY_PARAMS };

const SECRET_QUERY_PARAM_SET = new Set(SECRET_QUERY_PARAMS);

// `?name=value` / `&name=value` inside free text. Group 1 is the `?name=` prefix,
// group 2 the name; redactQueryParamsInText decides by the same name rule as
// redactUrlSecrets, so parsed URLs and free text redact the same params.
// Names and values stop at ?, & and #, so a param can't swallow a nested
// `?key=` (a redirect URL inside a value), and `?a?key=` is still caught.
const QUERY_PARAM_IN_TEXT_RE = /([?&]([^=?&#\s"']+)=)[^?&#\s"']*/g;

export function redactQueryParamsInText(text, placeholder = REDACTED) {
  return String(text ?? "").replace(QUERY_PARAM_IN_TEXT_RE, (match, prefix, name) => {
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep the raw name */ }
    return isSecretQueryParamName(decoded) ? prefix + placeholder : match;
  });
}

// `Bearer <token>` inside free text. Group 1 is `Bearer `.
export const BEARER_TOKEN_RE = BEARER_TOKEN_PATTERN;

export function isSensitiveHeader(name) {
  return typeof name === "string" && SENSITIVE_HEADER_PATTERN.test(name) && !NON_SECRET_HEADER_PATTERN.test(name);
}

export function isProviderDataSecretField(name) {
  return typeof name === "string" && PROVIDER_DATA_SECRET_NAME_PATTERN.test(name);
}

export function isSecretQueryParamName(name) {
  if (typeof name !== "string" || !name) return false;
  return SECRET_QUERY_PARAM_SET.has(name.toLowerCase()) || SECRET_QUERY_PARAM_NAME_PATTERN.test(name);
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

// Replaces the value of every query parameter that holds a credential.
export function redactUrlSecrets(url, placeholder = REDACTED) {
  if (typeof url !== "string" || !url.includes("?")) return url;
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const name of [...parsed.searchParams.keys()]) {
      if (isSecretQueryParamName(name)) {
        parsed.searchParams.set(name, placeholder);
        changed = true;
      }
    }
    // searchParams percent-encodes the placeholder; show it as written.
    return changed ? parsed.toString().split(encodeURIComponent(placeholder)).join(placeholder) : url;
  } catch {
    return redactQueryParamsInText(url, placeholder);
  }
}

// The stored credential values of a connection (API key, OAuth tokens, Copilot token).
export function credentialSecrets(credentials) {
  if (!credentials || typeof credentials !== "object") return [];
  const psd = credentials.providerSpecificData && typeof credentials.providerSpecificData === "object" ? credentials.providerSpecificData : {};
  const values = [
    ...CREDENTIAL_FIELDS.map((field) => credentials[field]),
    ...Object.entries(psd).filter(([name]) => isProviderDataSecretField(name)).map(([, value]) => value),
  ];
  return [...new Set(values.filter((v) => typeof v === "string" && v.length >= MIN_SECRET_VALUE_LENGTH))];
}

// providerSpecificData without its credential fields, for API responses.
// Everything else (region, profile ARN, auth method, model lists...) is kept.
// The fields are left out rather than masked: a client that sends the object
// back on update then keeps the stored secret, since updates merge.
export function withoutProviderDataSecrets(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  return Object.fromEntries(Object.entries(data).filter(([name]) => !isProviderDataSecretField(name)));
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
export function sanitizeSecrets(text, credentials = null, placeholder = REDACTED_TEXT) {
  if (!text) return text;
  let out = String(text).replace(BEARER_TOKEN_RE, `$1${placeholder}`);
  for (const secret of credentialSecrets(credentials)) {
    for (const form of secretForms(secret)) out = out.split(form).join(placeholder);
  }
  return out;
}

// Binary request bodies (Windsurf's protobuf carries the API key in its first
// field) are never logged or stored, only their size.
export function isBinaryBody(body) {
  return body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

export function binaryBodyMarker(body) {
  return isBinaryBody(body) ? `[binary ${body.byteLength} bytes]` : body;
}

// JSON.stringify replacer that writes every binary value as its size. A Buffer
// reaches a replacer already turned into { type: "Buffer", data: [...] } by its toJSON.
export function binaryJsonReplacer(_key, value) {
  if (value && value.type === "Buffer" && Array.isArray(value.data)) return `[binary ${value.data.length} bytes]`;
  return binaryBodyMarker(value);
}
