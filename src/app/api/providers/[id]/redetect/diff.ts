// Re-detect on the endpoint page: what detection found now vs what the endpoint
// has saved, as a list of changes the user can apply. Pure, so it's tested
// directly (tests/unit/endpoint-redetect-diff.test.js).
import { buildRoutes } from "@/lib/endpointDetect.js";
import type { DetectFetch, DetectResult, Protocol } from "@/lib/endpointDetect.js";
import { sanitizeNodeQuirks } from "@/shared/utils/nodeQuirks.js";
import { applyAuthHeader, applyIdentityAndHeaders, getHeader } from "@/shared/utils/endpointOverrides.js";

export interface SavedEndpoint {
  type?: string;            // "openai-compatible" | "anthropic-compatible"
  apiType?: string;         // "chat" | "responses"
  baseUrl?: string;
  maxCompletionTokens?: boolean;
  apiKeyHeader?: string | null;
  modelRoutes?: Record<string, string>;
}

export interface RedetectDiff {
  ok: boolean;
  error?: string;
  // The API detection found, and whether it can be applied in place: an OpenAI
  // node can switch Chat <-> Responses; OpenAI <-> Anthropic needs a new endpoint.
  protocol: { from: Protocol; to: Protocol; applicable: boolean } | null;
  baseUrl: { from: string; to: string } | null;
  addModels: string[];
  // Only when the endpoint listed its models itself (/models): a guessed list
  // that misses a model isn't proof the model is gone.
  removeModels: string[];
  quirks: { maxCompletionTokens?: boolean; apiKeyHeader?: "api-key" | null; modelRoutes?: Record<string, string> };
  modelsNote: string | null;
  keyConfirmed?: string;
  changes: number;
}

export const savedProtocol = (n: SavedEndpoint): Protocol =>
  n.type === "anthropic-compatible" ? "anthropic" : n.apiType === "responses" ? "openai-responses" : "openai-chat";

// Probe as the endpoint is set up to be called: its client identity (mimic,
// custom headers), header overrides, and how the key is sent (authHeader, or
// apiKeyHeader off /messages, like the executor). Requests that carry no key
// (the no-auth /models try) stay keyless. An endpoint saved via "Connect as
// Codex CLI" is client-gated, so without this every re-detect is refused.
// `identity: false` leaves out the saved mimic, for the client-identity retry
// whose own preset headers must not be overwritten.
export function savedSettingsFetch(fetchFn: DetectFetch, node: unknown, apiKey: string, { identity = true }: { identity?: boolean } = {}): DetectFetch {
  const q0 = sanitizeNodeQuirks(node);
  const q = identity ? q0 : { ...q0, mimic: undefined, customHeaders: undefined };
  const key = String(apiKey || "").trim();
  return (url, init) => {
    const headers = { ...init.headers };
    const messagesPath = /\/messages(?:\?|$)/.test(url);
    const keyed = ["authorization", "x-api-key", "api-key"].some((h) => getHeader(headers, h) !== undefined);
    if (keyed && key) {
      if (q.authHeader) applyAuthHeader(headers, q.authHeader, key);
      else if (q.apiKeyHeader === "api-key" && !messagesPath) applyAuthHeader(headers, "api-key", key);
    }
    applyIdentityAndHeaders(headers, q, { messagesPath });
    return fetchFn(url, { ...init, headers });
  };
}

const trimUrl = (u: unknown) => String(u || "").trim().replace(/\/+$/, "");

// The "source" note under the Models card title.
export function modelsNoteFor(r: Pick<DetectResult, "modelsSource" | "models">): string | null {
  const n = r.models?.length || 0;
  switch (r.modelsSource) {
    case "models": return `imported from /models (${n} model${n === 1 ? "" : "s"})`;
    case "catalog": return "checked one by one against the models.dev catalog (no /models endpoint)";
    case "guessed": return "checked one by one against the latest models (no /models endpoint)";
    default: return null;
  }
}

const sameRoutes = (a: Record<string, string> = {}, b: Record<string, string> = {}) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

// Model routes from the per-API probe results, or null when nothing changes.
// detectEndpoint's own `routes` are relative to whichever API served the most
// models, not to the node's saved API, so they're rebuilt here around `target`
// (the saved API, or the new one when a Chat <-> Responses switch is offered).
// The offer is the full model -> API map, so the PUT can drop the entries for
// whichever API the node ends up on, whether or not the switch is applied.
// When the endpoint no longer splits models, it offers {} to clear old routes.
function routesChange(node: SavedEndpoint, r: DetectResult, target: Protocol): Record<string, string> | null {
  // No per-API probing (it listed /models): nothing is known about routes.
  if (!r.byProtocol) return null;
  const built = buildRoutes(r.byProtocol, target);
  if (!built.models.length) return null;
  const saved = node.modelRoutes || {};
  if (!Object.keys(built.routes).length) {
    // An early stop leaves some API's list short: not proof the split is gone.
    return Object.keys(saved).length && !r.partial ? {} : null;
  }
  if (sameRoutes(saved, built.routes)) return null;
  return Object.fromEntries(built.models.map((m) => [m, built.routes[m] || target]));
}

export function redetectDiff(node: SavedEndpoint, currentModels: string[], r: DetectResult): RedetectDiff {
  const empty: RedetectDiff = { ok: false, protocol: null, baseUrl: null, addModels: [], removeModels: [], quirks: {}, modelsNote: null, changes: 0 };
  if (!r.ok) return { ...empty, error: r.error || "Detection failed", keyConfirmed: r.keyConfirmed };
  const from = savedProtocol(node);
  const to = r.protocol || from;
  const protocol = to !== from ? { from, to, applicable: from !== "anthropic" && to !== "anthropic" } : null;
  const baseUrl = r.baseUrl && trimUrl(r.baseUrl) !== trimUrl(node.baseUrl) ? { from: trimUrl(node.baseUrl), to: trimUrl(r.baseUrl) } : null;
  const found = r.models || [];
  const have = new Set(currentModels);
  const addModels = found.filter((m) => !have.has(m));
  const removeModels = r.modelsSource === "models" ? currentModels.filter((m) => !found.includes(m)) : [];
  const quirks: RedetectDiff["quirks"] = {};
  if (r.quirks?.maxCompletionTokens && !node.maxCompletionTokens) quirks.maxCompletionTokens = true;
  if (r.quirks?.apiKeyHeader && node.apiKeyHeader !== "api-key") quirks.apiKeyHeader = "api-key";
  const modelRoutes = routesChange(node, r, protocol?.applicable ? to : from);
  if (modelRoutes) quirks.modelRoutes = modelRoutes;
  const changes = (protocol ? 1 : 0) + (baseUrl ? 1 : 0) + addModels.length + removeModels.length + Object.keys(quirks).length;
  return { ok: true, protocol, baseUrl, addModels, removeModels, quirks, modelsNote: modelsNoteFor(r), keyConfirmed: r.keyConfirmed, changes };
}
