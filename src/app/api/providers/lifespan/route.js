import { NextResponse } from "next/server";
import { getKeyLifespans } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// GET /api/providers/lifespan?provider=<id> - how much life each active key of
// the provider has left, from what its earlier dead keys consumed.
export async function GET(request) {
  const provider = new URL(request.url).searchParams.get("provider");
  if (!provider) return NextResponse.json({ error: "provider is required" }, { status: 400 });
  try {
    return NextResponse.json(await getKeyLifespans(provider));
  } catch (error) {
    console.log("Error estimating key lifespans:", error);
    return NextResponse.json({ error: "Failed to estimate key lifespans" }, { status: 500 });
  }
}
