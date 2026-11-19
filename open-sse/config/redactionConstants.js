// What counts as a secret when a request, URL or error text leaves the server
// (request logs, request details, the Translator preview, error messages, CLI
// tool statuses, provider listings). Used by utils/redact.js; keep every
// redaction rule here.

// Header names that carry credentials: Authorization, x-api-key, x-goog-api-key,
// api-key, cookies, and any *token* / *secret* / *password* header (x-9r-cli-token,
// x-9r-peer-token, ...).
export const SENSITIVE_HEADER_PATTERN = /authorization|api-key|apikey|cookie|token|secret|password/i;

// Usage counters that match the pattern above only because they count tokens
// (x-ratelimit-remaining-tokens, anthropic-ratelimit-input-tokens-limit, ...).
// They carry numbers and reset times, never credentials, and logs need them.
export const NON_SECRET_HEADER_PATTERN = /ratelimit|-tokens$|-tokens-/i;

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
// Any other query param whose name says it holds a credential (exaApiKey,
// tavilyApiKey, refresh_token, client_secret, x-amz-signature, ...).
export const SECRET_QUERY_PARAM_NAME_PATTERN = /key|token|secret|auth|sig/i;

// `Authorization: Bearer <token>` inside free text.
export const BEARER_TOKEN_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

// The TypeError undici throws for a header value it refuses, which quotes the
// whole value (`Bearer <token>` included).
export const INVALID_HEADER_ERROR_PATTERN = /invalid header value|invalid character in header/i;

// Stored credential fields whose values must never appear in output.
export const CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken", "copilotToken"];
// Secrets some providers keep in providerSpecificData (Copilot's bearer token,
// Kiro IDC's clientSecret, Windsurf's firebaseIdToken, ...): any field whose name
// ends in token/secret/password/cookie/apiKey. Counters like maxCompletionTokens
// and URLs like tokenEndpoint don't match.
export const PROVIDER_DATA_SECRET_NAME_PATTERN = /(token|secret|password|cookie|api_?key)$/i;

// Values shorter than this are not substituted inside text: replacing a 3-character
// "key" would mangle every word that contains it.
export const MIN_SECRET_VALUE_LENGTH = 8;

export const REDACTED = "[REDACTED]";
// The marker sanitizeSecrets writes into error text by default.
export const REDACTED_TEXT = "[redacted]";
