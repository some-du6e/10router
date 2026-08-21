import {
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENTS,
} from "./constants.js";

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatRemaining(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.max(0, Math.round(value))}% remaining`;
}

export function buildNotificationMessage(event) {
  const title = event.type === NOTIFICATION_EVENTS.TEST
    ? "10router test notification"
    : `${event.provider || "Provider"} ${NOTIFICATION_EVENT_LABELS[event.type] || "notification"}`;

  const details = [];
  if (event.connectionName) details.push(`Account: ${event.connectionName}`);
  if (event.quotaName) details.push(`Limit: ${event.quotaName}`);
  const remaining = formatRemaining(event.remainingPercentage);
  if (remaining) details.push(`Status: ${remaining}`);
  const resetAt = formatDate(event.resetAt);
  if (event.type === NOTIFICATION_EVENTS.QUOTA_EXHAUSTED && resetAt) details.push(`Resets at: ${resetAt}`);
  if (event.type === NOTIFICATION_EVENTS.QUOTA_RESET && resetAt) details.push(`New reset: ${resetAt}`);
  if (event.type === NOTIFICATION_EVENTS.TEST) details.push("Your notification channel is working.");

  return {
    title,
    body: details.join("\n"),
    severity: event.type === NOTIFICATION_EVENTS.QUOTA_EXHAUSTED ? "warning" : "success",
  };
}

export function buildWebhookPayload(event, message) {
  return {
    source: "10router",
    event: event.type,
    timestamp: event.timestamp || new Date().toISOString(),
    title: message.title,
    message: message.body,
    provider: event.provider || null,
    connection: event.connectionId ? {
      id: event.connectionId,
      name: event.connectionName || null,
    } : null,
    quota: event.quotaName ? {
      name: event.quotaName,
      remainingPercentage: event.remainingPercentage ?? null,
      resetAt: event.resetAt || null,
    } : null,
  };
}
