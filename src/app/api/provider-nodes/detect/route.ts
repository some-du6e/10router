import { NextResponse } from "next/server";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { detectEndpoint, fetchSiteInfo, normalizeUrl } from "@/lib/endpointDetect.js";
import type { DetectProgress, SiteFetch, SiteInfo } from "@/lib/endpointDetect.js";
import { getEndpointCatalog } from "@/lib/endpointCatalog.js";
import { retryAsClient } from "@/lib/endpointImpersonate.js";
import { guardTarget, respond } from "./ndjson.js";

export const dynamic = "force-dynamic";

// POST /api/provider-nodes/detect - Work out protocol, base URL, models and auth
// from a URL + key. Free probes only; never triggers a billed generation.
// Also reads the provider's own site (no key sent, SSRF-guarded, 4s cap) for a
// name and icon. Streams progress as NDJSON when asked (see ndjson.ts).
export async function POST(request: Request) {
  let body: { url?: string; apiKey?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Bad request", steps: [] }, { status: 400 }); }
  const base = normalizeUrl(body.url);
  if (!base) return NextResponse.json({ ok: false, error: "That doesn't look like a URL.", steps: [] }, { status: 400 });
  const guard = await guardTarget(request, base);
  if (guard instanceof NextResponse) return guard;

  const fetchFn = makeProbeFetch(guard.remote);
  // The site is always a public host: guarded for every caller.
  const siteFetch = makeProbeFetch(true) as unknown as SiteFetch;
  return respond(request, "detecting endpoint", async (signal, send) => {
    const site: Promise<SiteInfo | null> = fetchSiteInfo(base, siteFetch, { signal }).catch(() => null);
    const catalog = await getEndpointCatalog();
    // The retry below is a second run whose request numbers start at 1 again;
    // shift them past the first run's so the dialog's list keeps both.
    let maxN = 0, offset = 0, sentBase = 0, maxSent = 0;
    const onProgress = (e: DetectProgress) => {
      const ev = { ...e } as DetectProgress & { n?: number; sent?: number };
      if (typeof ev.n === "number") { ev.n += offset; maxN = Math.max(maxN, ev.n); }
      if (typeof ev.sent === "number") { ev.sent += sentBase; maxSent = Math.max(maxSent, ev.sent); }
      send(ev);
    };
    const first = await detectEndpoint({ url: base, apiKey: body.apiKey, fetchFn, catalog, signal, onProgress });
    // Client-gated: try known client identities (free requests only) and, when
    // one gets in, detect again as that client. The dialog asks before using it.
    const result = await retryAsClient(first, {
      url: base, apiKey: body.apiKey, fetchFn, signal,
      detect: (f) => { offset = maxN; sentBase = maxSent; return detectEndpoint({ url: base, apiKey: body.apiKey, fetchFn: f, catalog, signal, onProgress }); },
    });
    return { ...result, site: await site };
  }, { ok: false, error: "Detection failed", steps: [] });
}
