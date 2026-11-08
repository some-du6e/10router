import { NextResponse } from "next/server";
import { getApiKeyById, getApiKeyUsageDetail } from "@/lib/db/index.js";
import { budgetState } from "@/shared/utils/apiKeyLimits.js";

export const dynamic = "force-dynamic";

// GET /api/keys/[id]/usage - spend detail for one key: per day (30 days), per model, latest requests
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    const usage = await getApiKeyUsageDetail(key.key, { dailyDays: 30 });
    return NextResponse.json({
      id: key.id,
      name: key.name,
      budget: budgetState(key),
      lifetimeSpentUsd: key.lifetimeSpentUsd,
      spendResetAt: key.spendResetAt,
      requestCount: key.requestCount,
      lastUsedAt: key.lastUsedAt,
      ...usage,
    });
  } catch (error) {
    console.log("Error fetching key usage:", error);
    return NextResponse.json({ error: "Failed to fetch key usage" }, { status: 500 });
  }
}
