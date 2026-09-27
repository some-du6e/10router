import { NOTIFICATION_EVENTS } from "./constants.js";
import { notificationProviderName } from "./providerName.js";

const MAX_FIELDS = 10;
const MAX_LABEL_LENGTH = 75;
const MAX_TEMPLATE_LENGTH = 200;

export const DEFAULT_SLACK_FIELDS = Object.freeze([
  { id: "provider", label: "Provider", value: "{{provider}}" },
  { id: "account", label: "Account", value: "{{account}}" },
  { id: "limit", label: "Limit", value: "{{limit}}" },
  { id: "resets", label: "Resets", value: "{{resetAt}}" },
]);

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function defaultFields() {
  return DEFAULT_SLACK_FIELDS.map((field) => ({ ...field }));
}

export function normalizeSlackLayout(layout) {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) {
    return { fields: defaultFields() };
  }

  const seen = new Set();
  const fields = (Array.isArray(layout.fields) ? layout.fields : [])
    .slice(0, MAX_FIELDS)
    .map((field, index) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return null;
      const baseId = cleanText(field.id, 40).replace(/[^a-zA-Z0-9_-]/g, "") || `field-${index + 1}`;
      let id = baseId;
      let suffix = 2;
      while (seen.has(id)) id = `${baseId}-${suffix++}`;
      seen.add(id);

      const label = cleanText(field.label, MAX_LABEL_LENGTH);
      const value = cleanText(field.value, MAX_TEMPLATE_LENGTH);
      return label && value ? { id, label, value } : null;
    })
    .filter(Boolean);

  return { fields: fields.length > 0 ? fields : defaultFields() };
}

function escapeMrkdwn(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatResetAt(value) {
  if (!value) return "Not provided";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function templateValues(payload) {
  const remaining = payload?.quota?.remainingPercentage;
  return {
    provider: payload?.provider ? notificationProviderName(payload.provider) : "Not provided",
    account: payload?.connection?.name || "Not provided",
    limit: payload?.quota?.name || "Not provided",
    resetAt: formatResetAt(payload?.quota?.resetAt),
    remaining: Number.isFinite(remaining) ? `${Math.max(0, Math.round(remaining))}%` : "Not provided",
  };
}

export function renderSlackTemplate(template, payload) {
  const values = templateValues(payload);
  return String(template).replace(/\{\{(provider|account|limit|resetAt|remaining)\}\}/g, (_, key) => values[key]);
}

function slackSummary(eventType) {
  if (eventType === NOTIFICATION_EVENTS.QUOTA_EXHAUSTED) {
    return "Requests will automatically fall back to the next available account.";
  }
  if (eventType === NOTIFICATION_EVENTS.QUOTA_RESET) {
    return "This account is available for routing again.";
  }
  return "Your notification channel is working.";
}

function statusMeta(eventType) {
  if (eventType === NOTIFICATION_EVENTS.QUOTA_EXHAUSTED) {
    return { color: "#e98300", icon: ":warning:", label: "QUOTA EXHAUSTED" };
  }
  if (eventType === NOTIFICATION_EVENTS.QUOTA_RESET) {
    return { color: "#20c66a", icon: ":white_check_mark:", label: "QUOTA RESET" };
  }
  return { color: "#1d9bd1", icon: ":white_check_mark:", label: "TEST NOTIFICATION" };
}

export function buildSlackPayload(channel, message, payload) {
  const eventType = payload?.event;
  const status = statusMeta(eventType);
  const layout = normalizeSlackLayout(channel?.config?.slackLayout);
  const fields = layout.fields.map((field) => ({
    type: "mrkdwn",
    text: `*${escapeMrkdwn(field.label)}*\n${escapeMrkdwn(renderSlackTemplate(field.value, payload))}`,
  }));

  const blocks = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${status.icon} *${status.label}*  •  10router` }],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMrkdwn(message.title)}*\n${escapeMrkdwn(slackSummary(eventType))}`,
      },
    },
  ];

  if (fields.length > 0) blocks.push({ type: "section", fields });

  const remaining = payload?.quota?.remainingPercentage;
  const context = Number.isFinite(remaining)
    ? `${Math.max(0, Math.round(remaining))}% remaining`
    : eventType === NOTIFICATION_EVENTS.TEST
      ? "Test delivery from 10router"
      : "Quota state updated";
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(context) }] });

  return {
    text: message.title,
    attachments: [{ color: status.color, blocks }],
  };
}
