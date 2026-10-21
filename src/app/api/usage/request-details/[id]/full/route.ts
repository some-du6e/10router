import { NextResponse } from "next/server";
import { getRequestDetailFullData, getSettings } from "@/lib/db/index.js";

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
    return NextResponse.json(full, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to get full request detail:", error);
    const corrupt = error instanceof Error && error.message.includes("corrupt");
    return NextResponse.json(
      { error: corrupt ? "The stored full payload is corrupt" : "Failed to fetch full request detail" },
      { status: 500 },
    );
  }
}
