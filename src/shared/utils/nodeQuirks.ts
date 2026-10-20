// Per-endpoint compatibility fixes for user-added OpenAI/Anthropic-compatible
// nodes. Stored on the node and copied onto every connection's
// providerSpecificData, which is where the executor reads them.
//   stripBeta            send no anthropic-beta header at all
//   droppedBetas         beta flags this endpoint rejected (learned at runtime)
//   maxCompletionTokens  rename max_tokens → max_completion_tokens (Snowflake chat)
//   modelRoutes          model → API path, for endpoints that answer on both
//                        Anthropic Messages and OpenAI (see resolveCompatibleRoute)
//   apiKeyHeader         "api-key": send the key in an api-key header, not Bearer (Azure)
export const QUIRK_KEYS: readonly (keyof NodeQuirks)[] = ["stripBeta", "droppedBetas", "maxCompletionTokens", "modelRoutes", "apiKeyHeader"];
export const ROUTE_PROTOCOLS: readonly RouteProtocol[] = ["anthropic", "openai-chat", "openai-responses"];
const MAX_ROUTES = 500;

export type RouteProtocol = "anthropic" | "openai-chat" | "openai-responses";

// Sanitized quirks. apiKeyHeader is null only in an edit (keepEmpty) that turns it off.
export type NodeQuirks = {
  stripBeta?: boolean;
  droppedBetas?: string[];
  maxCompletionTokens?: boolean;
  modelRoutes?: Record<string, RouteProtocol>;
  apiKeyHeader?: "api-key" | null;
};

const isRouteProtocol = (p: unknown): p is RouteProtocol =>
  typeof p === "string" && (ROUTE_PROTOCOLS as readonly string[]).includes(p);

const FLAG_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,120}$/;

// Keep only known keys with the right types. keepEmpty keeps false/[] so an edit
// can switch a fix back off.
export function sanitizeNodeQuirks(raw: unknown, { keepEmpty = false }: { keepEmpty?: boolean } = {}): NodeQuirks {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: NodeQuirks = {};
  for (const k of ["stripBeta", "maxCompletionTokens"] as const) {
    const v = r[k];
    if (typeof v === "boolean" && (v || keepEmpty)) out[k] = v;
  }
  if (r.apiKeyHeader === "api-key" || r.apiKeyHeader === true) out.apiKeyHeader = "api-key"; // detection reports `true`
  else if (keepEmpty && r.apiKeyHeader === null) out.apiKeyHeader = null;
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
