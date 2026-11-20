import { NextResponse } from "next/server";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { normalizeUrl, sendTestMessage } from "@/lib/endpointDetect.js";
import type { Protocol } from "@/lib/endpointDetect.js";
import { selectAnthropicBeta } from "open-sse/providers/shared.js";
import { parseRejectedBetas, splitBetas } from "open-sse/utils/anthropicBeta.js";
import { guardTarget } from "../ndjson.js";

export const dynamic = "force-dynamic";

const PROTOCOLS: Protocol[] = ["anthropic", "openai-chat", "openai-responses"];
// Never sent to third-party hosts (see open-sse/utils/anthropicBeta.ts).
const NEVER_SENT = new Set(["claude-code-20250219"]);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,120}$/;

// POST /api/provider-nodes/detect/test-message - the opt-in "Test with model":
// ONE real "hi" with a 1-token cap to the model the user picked. On Anthropic
// Messages it carries Claude Code's beta flags; a 400 naming rejected flags
// drops exactly those and retries once, and the answer says which were dropped.
// Body: { baseUrl, apiKey, protocol, model, quirks: { stripBeta, droppedBetas, maxCompletionTokens, apiKeyHeader } }.
export async function POST(request: Request) {
  let body: { baseUrl?: string; apiKey?: string; protocol?: string; model?: string; quirks?: Record<string, unknown> };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 }); }
  const base = normalizeUrl(body.baseUrl);
  if (!base) return NextResponse.json({ ok: false, error: "That doesn't look like a URL." }, { status: 400 });
  const protocol = PROTOCOLS.find((p) => p === body.protocol);
  if (!protocol) return NextResponse.json({ ok: false, error: "Unknown API type" }, { status: 400 });
  const model = String(body.model || "");
  if (!MODEL_RE.test(model)) return NextResponse.json({ ok: false, error: "Pick a model" }, { status: 400 });
  const guard = await guardTarget(request, base);
  if (guard instanceof NextResponse) return guard;

  const q = body.quirks || {};
  const quirks = {
    stripBeta: q.stripBeta === true,
    droppedBetas: Array.isArray(q.droppedBetas) ? q.droppedBetas.filter((x): x is string => typeof x === "string") : [],
    maxCompletionTokens: q.maxCompletionTokens === true,
    apiKeyHeader: q.apiKeyHeader === true || q.apiKeyHeader === "api-key",
  };
  try {
    const result = await sendTestMessage({
      baseUrl: base, apiKey: body.apiKey, protocol, model, quirks,
      betas: splitBetas(selectAnthropicBeta(model)).filter((b) => !NEVER_SENT.has(b)),
      parseRejected: parseRejectedBetas,
      fetchFn: makeProbeFetch(guard.remote),
      signal: request.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error sending test message:", error instanceof Error ? error.message : undefined);
    return NextResponse.json({ ok: false, error: "Test failed" }, { status: 500 });
  }
}
