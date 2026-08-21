export const NOTIFICATION_TYPES = Object.freeze({
  NTFY: "ntfy",
  SLACK: "slack",
  WEBHOOK: "webhook",
  TELEGRAM: "telegram",
  APPRISE: "apprise",
});

export const NOTIFICATION_EVENTS = Object.freeze({
  QUOTA_EXHAUSTED: "quota_exhausted",
  QUOTA_RESET: "quota_reset",
  TEST: "test",
});

export const NOTIFICATION_EVENT_LABELS = Object.freeze({
  [NOTIFICATION_EVENTS.QUOTA_EXHAUSTED]: "Quota exhausted",
  [NOTIFICATION_EVENTS.QUOTA_RESET]: "Quota reset",
  [NOTIFICATION_EVENTS.TEST]: "Test notification",
});

export const NOTIFICATION_CONFIG = Object.freeze({
  tickIntervalMs: 60_000,
  claudePollIntervalMs: 180_000,
  requestTimeoutMs: 15_000,
  maxResponseChars: 500,
});

export const NOTIFICATION_TYPE_OPTIONS = Object.freeze([
  { value: NOTIFICATION_TYPES.NTFY, label: "ntfy", icon: "notifications_active" },
  { value: NOTIFICATION_TYPES.SLACK, label: "Slack", icon: "tag" },
  { value: NOTIFICATION_TYPES.WEBHOOK, label: "Webhook", icon: "webhook" },
  { value: NOTIFICATION_TYPES.TELEGRAM, label: "Telegram", icon: "send" },
  { value: NOTIFICATION_TYPES.APPRISE, label: "Apprise API", icon: "hub" },
]);

export const SECRET_CONFIG_FIELDS = Object.freeze({
  [NOTIFICATION_TYPES.NTFY]: ["token", "password"],
  [NOTIFICATION_TYPES.SLACK]: ["webhookUrl"],
  [NOTIFICATION_TYPES.WEBHOOK]: ["bearerToken", "headers"],
  [NOTIFICATION_TYPES.TELEGRAM]: ["botToken"],
  [NOTIFICATION_TYPES.APPRISE]: ["serviceUrls"],
});
