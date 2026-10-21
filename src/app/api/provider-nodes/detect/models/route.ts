import { NextResponse } from "next/server";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { checkModels, normalizeUrl } from "@/lib/endpointDetect.js";
import type { DetectProgress, Protocol } from "@/lib/endpointDetect.js";
import { guardTarget, respond } from "../ndjson.js";

export const dynamic = "force-dynamic";

const PROTOCOLS: Protocol[] = ["anthropic", "openai-chat", "openai-responses"];

// POST /api/provider-nodes/detect/models - "Check the rest": ask about the ids
// a detection never got to, one at a time. Free requests only (empty body,
// 1-token cap), same as detection. Body: { baseUrl, apiKey, protocol, ids, quirks }.
export async function POST(request: Request) {
  let body: { baseUrl?: string; apiKey?: string; protocol?: string; ids?: unknown; quirks?: { maxCompletionTokens?: boolean; apiKeyHeader?: boolean } };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Bad request", steps: [] }, { status: 400 }); }
  const base = normalizeUrl(body.baseUrl);
  if (!base) return NextResponse.json({ ok: false, error: "That doesn't look like a URL.", steps: [] }, { status: 400 });
  const protocol = PROTOCOLS.find((p) => p === body.protocol);
  if (!protocol) return NextResponse.json({ ok: false, error: "Unknown API type", steps: [] }, { status: 400 });
  if (!Array.isArray(body.ids) || !body.ids.length) return NextResponse.json({ ok: false, error: "No model ids", steps: [] }, { status: 400 });
  const guard = await guardTarget(request, base);
  if (guard instanceof NextResponse) return guard;

  const ids = body.ids.filter((x): x is string => typeof x === "string");
  const quirks = { maxCompletionTokens: body.quirks?.maxCompletionTokens === true, apiKeyHeader: body.quirks?.apiKeyHeader === true };
  const fetchFn = makeProbeFetch(guard.remote);
  return respond(request, "checking models", (signal, send) =>
    checkModels({ baseUrl: base, apiKey: body.apiKey, protocol, ids, quirks, fetchFn, signal, onProgress: (e: DetectProgress) => send(e) }),
  { ok: false, error: "Model check failed", models: [], steps: [] });
}
