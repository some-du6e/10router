import { NextResponse } from "next/server";
import {
  deleteNotificationChannel,
  getNotificationChannelById,
  getNotificationChannels,
  updateNotificationChannel,
} from "@/lib/db/index.js";
import {
  normalizeNotificationChannelInput,
  redactNotificationChannel,
} from "@/lib/notifications/validation.js";

function configureScheduler(channels) {
  import("@/shared/services/quotaNotifications")
    .then(({ configureQuotaNotifications }) => {
      configureQuotaNotifications(channels.some((channel) => channel.isActive));
    })
    .catch((error) => console.warn("[Notifications] scheduler config failed:", error.message));
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getNotificationChannelById(id);
    if (!existing) return NextResponse.json({ error: "Notification channel not found" }, { status: 404 });

    const body = await request.json();
    const input = normalizeNotificationChannelInput(body, existing);
    const channel = await updateNotificationChannel(id, input);
    configureScheduler(await getNotificationChannels());
    return NextResponse.json({ channel: redactNotificationChannel(channel) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const removed = await deleteNotificationChannel(id);
    if (!removed) return NextResponse.json({ error: "Notification channel not found" }, { status: 404 });
    configureScheduler(await getNotificationChannels());
    return NextResponse.json({ success: true });
  } catch (error) {
    console.warn("[Notifications] delete failed:", error.message);
    return NextResponse.json({ error: "Failed to delete notification channel" }, { status: 500 });
  }
}
