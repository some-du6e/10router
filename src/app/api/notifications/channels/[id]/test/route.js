import { NextResponse } from "next/server";
import { sendTestNotification } from "@/lib/notifications/index.js";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    await sendTestNotification(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = error.message === "Notification channel not found" ? 404 : 502;
    return NextResponse.json({ error: error.message }, { status });
  }
}
