import { NextResponse } from "next/server";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { privateUrlRejected, proxyUrlProblem } from "@/lib/network/privateUrls.js";

export async function POST(request) {
  try {
    const body = await request.json();
    for (const field of ["proxyUrl", "testUrl"]) {
      const value = body?.[field];
      if (value !== undefined && value !== null && typeof value !== "string") {
        return NextResponse.json({ ok: false, error: `${field} must be a string`, field }, { status: 400 });
      }
    }
    // The proxy and the page fetched through it get the same rule as a saved
    // proxy: a remote session can't aim either at a private host.
    if (typeof body?.proxyUrl === "string" && body.proxyUrl.trim()) {
      const problem = await proxyUrlProblem(request, body.proxyUrl);
      if (problem) return NextResponse.json({ ok: false, error: problem, field: "proxyUrl" }, { status: 400 });
    }
    if (typeof body?.testUrl === "string" && body.testUrl.trim()) {
      const problem = await privateUrlRejected(request, body.testUrl.trim());
      if (problem) return NextResponse.json({ ok: false, error: problem, field: "testUrl" }, { status: 400 });
    }

    const result = await testProxyUrl({
      proxyUrl: body?.proxyUrl,
      testUrl: body?.testUrl,
      timeoutMs: body?.timeoutMs,
    });

    if (result?.ok) {
      return NextResponse.json(result);
    }

    const status = typeof result?.status === "number" ? result.status : 500;
    return NextResponse.json({ ok: false, error: result?.error || "Proxy test failed" }, { status });
  } catch (err) {
    const message = err?.name === "AbortError" ? "Proxy test timed out" : (err?.message || String(err));
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
