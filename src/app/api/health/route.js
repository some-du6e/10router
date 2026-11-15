import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// Set by server-drain.js (loaded by custom-server.js) once a shutdown signal starts the drain.
const DRAINING_KEY = Symbol.for("10router.server.draining");

export async function GET() {
  if (globalThis[DRAINING_KEY] === true) {
    return NextResponse.json(
      { ok: false, draining: true },
      { status: 503, headers: { ...CORS_HEADERS, "Retry-After": "5", "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json({ ok: true }, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
