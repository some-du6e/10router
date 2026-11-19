import { NextResponse } from "next/server";
import { getRequestDetailById, getSettings } from "@/lib/db/index.js";
import { getProviderLabeler, labelRequestDetail } from "@/lib/requestDetailLabels.js";
import { redactRequestDetails } from "../route.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/request-details/:id
 * One stored request with its (possibly truncated) payloads, redacted unless
 * "Show full request details" is on.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const detail = await getRequestDetailById(id);
    if (!detail) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }
    const [settings, labels] = await Promise.all([getSettings(), getProviderLabeler()]);
    const [visible] = settings.showSensitiveRequestDetails === true ? [detail] : redactRequestDetails([detail]);
    return NextResponse.json(labelRequestDetail(visible, labels), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to get request detail:", error);
    return NextResponse.json({ error: "Failed to fetch request detail" }, { status: 500 });
  }
}
