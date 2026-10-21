import { NextResponse } from "next/server";
import { getRequestDetailFullData } from "@/lib/db/index.js";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/request-details/:id/full
 * Returns the untruncated payloads kept for a large request, keyed like the
 * stored record (request, providerRequest, providerResponse, response).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const settings = await getSettings();
    if (settings.showSensitiveRequestDetails !== true) {
      return NextResponse.json({ error: "Full request details are turned off" }, { status: 403 });
    }
    const { id } = await params;
    const full = await getRequestDetailFullData(id);
    if (!full) {
      return NextResponse.json({ error: "Full payload is no longer stored" }, { status: 404 });
    }
    return NextResponse.json(full);
  } catch (error) {
    console.error("[API] Failed to get full request detail:", error);
    return NextResponse.json({ error: "Failed to fetch full request detail" }, { status: 500 });
  }
}
