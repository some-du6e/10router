// Per-endpoint compatibility fixes for user-added OpenAI/Anthropic-compatible
// nodes. Stored on the node and copied onto every connection's
// providerSpecificData, which is where the executor reads them.
//   stripBeta            send no anthropic-beta header at all
//   droppedBetas         beta flags this endpoint rejected (learned at runtime)
//   maxCompletionTokens  rename max_tokens → max_completion_tokens (Snowflake chat)
//   modelRoutes          model → API path, for endpoints that answer on both
//                        Anthropic Messages and OpenAI (see resolveCompatibleRoute)
//   apiKeyHeader         "api-key": send the key in an api-key header, not Bearer (Azure)
export const QUIRK_KEYS = ["stripBeta", "droppedBetas", "maxCompletionTokens", "modelRoutes", "apiKeyHeader"];
export const ROUTE_PROTOCOLS = ["anthropic", "openai-chat", "openai-responses"];
const MAX_ROUTES = 500;

const FLAG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,120}$/;

// Keep only known keys with the right types. keepEmpty keeps false/[] so an edit
// can switch a fix back off.
export function sanitizeNodeQuirks(raw, { keepEmpty = false } = {}) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const k of ["stripBeta", "maxCompletionTokens"]) {
    if (typeof raw[k] === "boolean" && (raw[k] || keepEmpty)) out[k] = raw[k];
  }
  if (raw.apiKeyHeader === "api-key") out.apiKeyHeader = "api-key";
  else if (keepEmpty && raw.apiKeyHeader === null) out.apiKeyHeader = null;
  if (Array.isArray(raw.droppedBetas)) {
    const flags = [...new Set(raw.droppedBetas.map((f) => String(f).trim()).filter((f) => FLAG_RE.test(f)))].slice(0, 50);
    if (flags.length || keepEmpty) out.droppedBetas = flags;
  }
  if (raw.modelRoutes && typeof raw.modelRoutes === "object" && !Array.isArray(raw.modelRoutes)) {
    const routes = Object.fromEntries(Object.entries(raw.modelRoutes)
      .filter(([m, p]) => MODEL_RE.test(m) && ROUTE_PROTOCOLS.includes(p))
      .slice(0, MAX_ROUTES));
    if (Object.keys(routes).length || keepEmpty) out.modelRoutes = routes;
  }
  return out;
}
