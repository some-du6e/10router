import { NextResponse } from "next/server";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { isLocalRequest } from "@/dashboardGuard";
import { detectEndpoint, normalizeUrl } from "@/lib/endpointDetect.js";

export const dynamic = "force-dynamic";

const MAX_REDIRECTS = 3;

// fetch for probes: SSRF check on every hop for remote callers, and redirects are
// followed only within the same origin so the key never goes to another host.
function makeProbeFetch(checkPublic) {
  return async (url, init) => {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (checkPublic) await assertPublicUrlResolved(current);
      const res = await fetch(current, { ...init, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      const next = new URL(location, current);
      if (next.origin !== new URL(current).origin || hop >= MAX_REDIRECTS) return res;
      // A POST that would turn into a GET means the URL is wrong; report the redirect as-is.
      if (init?.method === "POST" && (res.status === 301 || res.status === 302 || res.status === 303)) return res;
      current = next.toString();
    }
  };
}

// POST /api/provider-nodes/detect - Work out protocol, base URL, models and auth
// from a URL + key. Free probes only; never triggers a billed generation.
export async function POST(request) {
  try {
    const { url, apiKey } = await request.json();
    const base = normalizeUrl(url);
    if (!base) return NextResponse.json({ ok: false, error: "That doesn't look like a URL.", steps: [] }, { status: 400 });

    // SSRF guard for remote callers; local host keeps self-hosted endpoints (ollama, LM Studio, vLLM).
    const remote = !isLocalRequest(request);
    if (remote) {
      try { await assertPublicUrlResolved(base); }
      catch { return NextResponse.json({ ok: false, error: "URL not allowed", steps: [] }, { status: 400 }); }
    }

    const result = await detectEndpoint({ url: base, apiKey, fetchFn: makeProbeFetch(remote) });
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error detecting endpoint:", error?.message);
    return NextResponse.json({ ok: false, error: "Detection failed", steps: [] }, { status: 500 });
  }
}
