import { NextResponse } from "next/server";
import { getApiKeyById, getApiKeyUsageDetail } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// GET /api/keys/[id]/usage - spend detail for one key: per day (30 days), per model, latest requests.
// The key's totals (spend, budget, requests) are on GET /api/keys.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });
    const { daily, byModel, recent } = await getApiKeyUsageDetail(key.key, { dailyDays: 30 });
    return NextResponse.json({ daily, byModel, recent });
  } catch (error) {
    console.log("Error fetching key usage:", error);
    return NextResponse.json({ error: "Failed to fetch key usage" }, { status: 500 });
  }
}
