import { NextResponse } from "next/server";
import { sendTestNotification } from "@/lib/notifications/index.js";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    await sendTestNotification(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Notifications] test delivery failed:", error);
    const status = error.message === "Notification channel not found" ? 404 : 502;
    const detail = error.cause?.message && error.cause.message !== error.message
      ? `${error.message}: ${error.cause.message}`
      : error.message;
    return NextResponse.json({ error: detail }, { status });
  }
}
