import { NextResponse } from "next/server";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import { LAUNCH_CHALLENGE_HEADER, launchProofHeaders } from "@/lib/launchProof";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET(request) {
  const headers = { ...CORS_HEADERS };
  // Lets the CLI launcher tell its own server from anything else on the port.
  // The proof is bound to the TCP peer custom-server.js stamped, so only a
  // direct connection (no proxy hop) gets one.
  if (hasTrustedPeerHeaders(request) && !request.headers.get("x-9r-via-proxy")) {
    const proof = launchProofHeaders({
      challenge: request.headers.get(LAUNCH_CHALLENGE_HEADER),
      peerHost: request.headers.get("x-9r-real-ip"),
      peerPort: request.headers.get("x-9r-real-port"),
    });
    if (proof) Object.assign(headers, proof);
  }
  return NextResponse.json({ ok: true }, { headers });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
