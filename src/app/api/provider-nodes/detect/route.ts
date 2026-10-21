import { NextResponse } from "next/server";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { isLocalRequest } from "@/dashboardGuard";
import { detectEndpoint, normalizeUrl } from "@/lib/endpointDetect.js";
import { getEndpointCatalog } from "@/lib/endpointCatalog.js";

export const dynamic = "force-dynamic";

// POST /api/provider-nodes/detect - Work out protocol, base URL, models and auth
// from a URL + key. Free probes only; never triggers a billed generation.
export async function POST(request: Request) {
  try {
    const { url, apiKey } = (await request.json()) as { url?: string; apiKey?: string };
    const base = normalizeUrl(url);
    if (!base) return NextResponse.json({ ok: false, error: "That doesn't look like a URL.", steps: [] }, { status: 400 });

    // SSRF guard for remote callers; local host keeps self-hosted endpoints (ollama, LM Studio, vLLM).
    const remote = !isLocalRequest(request);
    if (remote) {
      try { await assertPublicUrlResolved(base); }
      catch { return NextResponse.json({ ok: false, error: "URL not allowed", steps: [] }, { status: 400 }); }
    }

    // request.signal: a client that gives up stops the probing too.
    const result = await detectEndpoint({ url: base, apiKey, fetchFn: makeProbeFetch(remote), catalog: await getEndpointCatalog(), signal: request.signal });
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error detecting endpoint:", error instanceof Error ? error.message : undefined);
    return NextResponse.json({ ok: false, error: "Detection failed", steps: [] }, { status: 500 });
  }
}
