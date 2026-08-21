import "server-only";

import {
  getNotificationChannelById,
  getNotificationChannels,
} from "@/lib/db/index.js";
import { NOTIFICATION_EVENTS, NOTIFICATION_TYPES } from "./constants.js";
import { buildNotificationMessage, buildWebhookPayload } from "./message.js";
import { sendNtfy } from "./providers/ntfy.js";
import { sendSlack } from "./providers/slack.js";
import { sendWebhook } from "./providers/webhook.js";
import { sendTelegram } from "./providers/telegram.js";
import { sendApprise } from "./providers/apprise.js";

const SENDERS = {
  [NOTIFICATION_TYPES.NTFY]: sendNtfy,
  [NOTIFICATION_TYPES.SLACK]: sendSlack,
  [NOTIFICATION_TYPES.WEBHOOK]: sendWebhook,
  [NOTIFICATION_TYPES.TELEGRAM]: sendTelegram,
  [NOTIFICATION_TYPES.APPRISE]: sendApprise,
};

export async function sendNotificationChannel(channel, event, deps = {}) {
  const sender = SENDERS[channel.type];
  if (!sender) throw new Error(`Unsupported notification type: ${channel.type}`);
  const message = buildNotificationMessage(event);
  const payload = buildWebhookPayload(event, message);
  await sender(channel, message, deps, payload);
}

export async function dispatchNotificationEvent(event, deps = {}) {
  const listChannels = deps.getNotificationChannels || getNotificationChannels;
  const channels = await listChannels({ isActive: true });
  const targets = channels.filter((channel) => channel.events?.includes(event.type));

  const results = await Promise.allSettled(
    targets.map(async (channel) => {
      await sendNotificationChannel(channel, event, deps);
      return channel.id;
    }),
  );

  const failures = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push({
        channelId: targets[index].id,
        name: targets[index].name,
        error: result.reason?.message || String(result.reason),
      });
    }
  });
  return { attempted: targets.length, sent: targets.length - failures.length, failures };
}

export async function sendTestNotification(channelId, deps = {}) {
  const getChannel = deps.getNotificationChannelById || getNotificationChannelById;
  const channel = await getChannel(channelId);
  if (!channel) throw new Error("Notification channel not found");
  await sendNotificationChannel(channel, {
    type: NOTIFICATION_EVENTS.TEST,
    timestamp: new Date().toISOString(),
  }, deps);
}
