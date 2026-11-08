import { estimateBillingUsage } from "./usageTracking.js";
import { STREAM_ABORT_FLOOR_TPS } from "../config/runtimeConfig.js";

type Body = Record<string, any> | null | undefined;
type Usage = Record<string, number | boolean>;

// The output cap, which an estimate never exceeds. When a body was sent
// upstream, only its cap counts: a translator may raise the client's
// (Claude's max_tokens for tools or a thinking budget, Kiro's fixed
// maxTokens) or drop it (Codex), and then the client's number says nothing
// about how much was generated. No cap upstream means no cap on the floor.
export function outputCap(b: Body): number | null {
  const cap = b?.max_tokens ?? b?.max_output_tokens ?? b?.max_completion_tokens
    ?? b?.generationConfig?.maxOutputTokens ?? b?.request?.generationConfig?.maxOutputTokens
    ?? b?.inferenceConfig?.maxTokens;
  return typeof cap === "number" && cap > 0 ? cap : null;
}

function parsed(b: unknown): Body {
  if (typeof b !== "string") return (b as Body) || null;
  try { return JSON.parse(b); } catch { return {}; }
}

/**
 * The usage to charge a request whose client hung up after it went upstream,
 * before any usage came back: input estimated from the client's body, output
 * the time floor from `floorFrom` to now (none when null), at most the output
 * cap sent upstream.
 */
export function hangUpUsage({ body, sentBody, floorFrom, now = Date.now() }: { body: Body; sentBody?: unknown; floorFrom: number | null; now?: number }): Usage {
  const billed = estimateBillingUsage(body, 0) as Usage;
  let out = floorFrom ? Math.floor((Math.max(0, now - floorFrom) / 1000) * STREAM_ABORT_FLOOR_TPS) : 0;
  const up = parsed(sentBody);
  const cap = up ? outputCap(up) : outputCap(body);
  if (cap) out = Math.min(out, cap);
  billed.completion_tokens = out;
  billed.total_tokens = (Number(billed.prompt_tokens) || 0) + out;
  return billed;
}
