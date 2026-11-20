// Shared by the detect routes: the SSRF check on the target, and the NDJSON
// stream the dashboard reads live progress from.
import { NextResponse } from "next/server";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { isLocalRequest } from "@/dashboardGuard";

export const NDJSON = "application/x-ndjson";

// The dashboard asks for live progress with `Accept: application/x-ndjson`
// (or ?stream=1): one JSON object per line, progress events as they happen,
// then { type: "result", ...the usual JSON }. Other callers get plain JSON.
export const wantsStream = (request: Request) =>
  (request.headers.get("accept") || "").includes(NDJSON) || new URL(request.url).searchParams.get("stream") === "1";

// Remote callers may only reach public hosts; the local host keeps self-hosted
// endpoints (ollama, LM Studio, vLLM). Returns { remote } or an error response.
export async function guardTarget(request: Request, url: string): Promise<{ remote: boolean } | NextResponse> {
  const remote = !isLocalRequest(request);
  if (remote) {
    try { await assertPublicUrlResolved(url); }
    catch { return NextResponse.json({ ok: false, error: "URL not allowed", steps: [] }, { status: 400 }); }
  }
  return { remote };
}

// Run `work` and answer with its result: plain JSON, or NDJSON progress lines
// then { type: "result", ... }. The client hanging up (or cancelling the stream
// read) aborts `signal`, which stops the probing.
export function respond<T extends object>(
  request: Request,
  label: string,
  work: (signal: AbortSignal, send: (e: object) => void) => Promise<T>,
  fallback: object,
): Response | Promise<Response> {
  if (!wantsStream(request)) {
    return work(request.signal, () => {}).then((r) => NextResponse.json(r)).catch((error) => {
      console.log(`Error ${label}:`, error instanceof Error ? error.message : undefined);
      return NextResponse.json(fallback, { status: 500 });
    });
  }
  const hangup = new AbortController();
  const signal = AbortSignal.any([request.signal, hangup.signal]);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let open = true;
      const send = (obj: object) => {
        if (!open) return;
        try { ctrl.enqueue(enc.encode(`${JSON.stringify(obj)}\n`)); } catch { open = false; }
      };
      try {
        send({ type: "result", ...(await work(signal, send)) });
      } catch (error) {
        console.log(`Error ${label}:`, error instanceof Error ? error.message : undefined);
        send({ type: "result", ...fallback });
      } finally {
        if (open) { open = false; try { ctrl.close(); } catch { /* already closed */ } }
      }
    },
    cancel() { hangup.abort(); },
  });
  return new Response(stream, { headers: { "content-type": `${NDJSON}; charset=utf-8`, "cache-control": "no-store", "x-accel-buffering": "no" } });
}
