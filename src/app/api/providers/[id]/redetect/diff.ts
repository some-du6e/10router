// Re-detect on the endpoint page: what detection found now vs what the endpoint
// has saved, as a list of changes the user can apply. Pure, so it's tested
// directly (tests/unit/endpoint-redetect-diff.test.js).
import type { DetectResult, Protocol } from "@/lib/endpointDetect.js";

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
  if (r.routes && Object.keys(r.routes).length && !sameRoutes(node.modelRoutes, r.routes)) quirks.modelRoutes = r.routes;
  const changes = (protocol ? 1 : 0) + (baseUrl ? 1 : 0) + addModels.length + removeModels.length + Object.keys(quirks).length;
  return { ok: true, protocol, baseUrl, addModels, removeModels, quirks, modelsNote: modelsNoteFor(r), keyConfirmed: r.keyConfirmed, changes };
}
