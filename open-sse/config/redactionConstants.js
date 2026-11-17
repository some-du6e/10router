// What counts as a secret when a request, URL or error text leaves the server
// (request logs, request details, the Translator preview, error messages).
// Used by utils/redact.js; keep every redaction rule here.

// Header names that carry credentials: Authorization, x-api-key, x-goog-api-key,
// api-key, cookies, and any *token* / *secret* / *password* header (x-9r-cli-token,
// x-9r-peer-token, ...).
export const SENSITIVE_HEADER_PATTERN = /authorization|api-key|apikey|cookie|token|secret|password/i;

// Query parameters that carry credentials (Vertex/Gemini put the API key in `key`,
// signed URLs in `sig`/`signature`, OAuth redirects in `code`). Matched case-insensitively.
export const SECRET_QUERY_PARAMS = [
  "key",
  "api_key",
  "api-key",
  "apikey",
  "access_token",
  "token",
  "auth",
  "sig",
  "signature",
  "code",
];

// Stored credential fields whose values must never appear in output.
export const CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken", "copilotToken"];
export const PROVIDER_DATA_CREDENTIAL_FIELDS = ["copilotToken", "accessToken", "refreshToken", "apiKey"];

// Values shorter than this are not substituted inside text: replacing a 3-character
// "key" would mangle every word that contains it.
export const MIN_SECRET_VALUE_LENGTH = 8;

export const REDACTED = "[REDACTED]";
