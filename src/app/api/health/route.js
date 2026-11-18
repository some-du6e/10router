import { NextResponse } from "next/server";
import { LAUNCH_CHALLENGE_HEADER, LAUNCH_PROOF_HEADER, launchProofFor } from "@/lib/launchProof";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET(request) {
  const headers = { ...CORS_HEADERS };
  // Lets the CLI launcher tell its own server from anything else on the port.
  const proof = launchProofFor(request?.headers?.get?.(LAUNCH_CHALLENGE_HEADER));
  if (proof) headers[LAUNCH_PROOF_HEADER] = proof;
  return NextResponse.json({ ok: true }, { headers });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
