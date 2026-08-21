import { NextResponse } from "next/server";
import {
  createNotificationChannel,
  getNotificationChannels,
} from "@/lib/db/index.js";
import {
  normalizeNotificationChannelInput,
  redactNotificationChannel,
} from "@/lib/notifications/validation.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function configureScheduler(channels) {
  import("@/shared/services/quotaNotifications")
    .then(({ configureQuotaNotifications }) => {
      configureQuotaNotifications(channels);
    })
    .catch((error) => console.warn("[Notifications] scheduler config failed:", error.message));
}

export async function GET() {
  try {
    const channels = await getNotificationChannels();
    return NextResponse.json({ channels: channels.map(redactNotificationChannel) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.warn("[Notifications] list failed:", error.message);
    return NextResponse.json({ error: "Failed to load notification channels" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const input = normalizeNotificationChannelInput(body);
    const channel = await createNotificationChannel(input);
    configureScheduler(await getNotificationChannels());
    return NextResponse.json({ channel: redactNotificationChannel(channel) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
