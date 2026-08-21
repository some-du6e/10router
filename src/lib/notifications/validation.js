import { isIP } from "node:net";
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_TYPES,
  SECRET_CONFIG_FIELDS,
} from "./constants.js";

const TYPE_VALUES = new Set(Object.values(NOTIFICATION_TYPES));
const EVENT_VALUES = new Set([
  NOTIFICATION_EVENTS.QUOTA_EXHAUSTED,
  NOTIFICATION_EVENTS.QUOTA_RESET,
]);
const URL_CONFIG_FIELDS = {
  [NOTIFICATION_TYPES.NTFY]: ["serverUrl"],
  [NOTIFICATION_TYPES.SLACK]: ["webhookUrl"],
  [NOTIFICATION_TYPES.WEBHOOK]: ["url"],
  [NOTIFICATION_TYPES.APPRISE]: ["apiUrl"],
};

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value, fallback = false) {
  return value === undefined ? fallback : value === true;
}

function normalizeEvents(events) {
  const list = Array.isArray(events) ? events : [];
  return [...new Set(list.filter((event) => EVENT_VALUES.has(event)))];
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key, value]) => stringValue(key) && typeof value === "string")
      .map(([key, value]) => [key.trim(), value.trim()]),
  );
}

function normalizeConfig(type, config = {}) {
  const next = {
    allowPrivateNetwork: booleanValue(config.allowPrivateNetwork),
  };

  switch (type) {
    case NOTIFICATION_TYPES.NTFY:
      next.serverUrl = stringValue(config.serverUrl) || "https://ntfy.sh";
      next.topic = stringValue(config.topic);
      next.token = stringValue(config.token);
      next.username = stringValue(config.username);
      next.password = stringValue(config.password);
      next.priority = stringValue(config.priority) || "default";
      next.tags = stringValue(config.tags);
      break;
    case NOTIFICATION_TYPES.SLACK:
      next.webhookUrl = stringValue(config.webhookUrl);
      break;
    case NOTIFICATION_TYPES.WEBHOOK:
      next.url = stringValue(config.url);
      next.method = stringValue(config.method).toUpperCase() || "POST";
      next.bearerToken = stringValue(config.bearerToken);
      next.headers = normalizeHeaders(config.headers);
      break;
    case NOTIFICATION_TYPES.TELEGRAM:
      next.botToken = stringValue(config.botToken);
      next.chatId = stringValue(config.chatId);
      next.messageThreadId = stringValue(config.messageThreadId);
      next.disableNotification = booleanValue(config.disableNotification);
      break;
    case NOTIFICATION_TYPES.APPRISE:
      next.apiUrl = stringValue(config.apiUrl);
      next.configKey = stringValue(config.configKey);
      next.serviceUrls = stringValue(config.serviceUrls);
      break;
    default:
      break;
  }

  return next;
}

function requireField(config, field, label) {
  if (!stringValue(config[field])) throw new Error(`${label} is required`);
}

function validateHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials in the URL`);
  }
  return url.toString();
}

function validateConfig(type, config) {
  for (const field of URL_CONFIG_FIELDS[type] || []) {
    requireField(config, field, field);
    config[field] = validateHttpUrl(config[field], field);
  }

  switch (type) {
    case NOTIFICATION_TYPES.NTFY:
      requireField(config, "topic", "Topic");
      if (config.token && (config.username || config.password)) {
        throw new Error("Use either an access token or username/password for ntfy");
      }
      if ((config.username && !config.password) || (!config.username && config.password)) {
        throw new Error("Both ntfy username and password are required for basic auth");
      }
      break;
    case NOTIFICATION_TYPES.WEBHOOK:
      if (!['POST', 'PUT', 'PATCH'].includes(config.method)) {
        throw new Error("Webhook method must be POST, PUT, or PATCH");
      }
      break;
    case NOTIFICATION_TYPES.TELEGRAM:
      requireField(config, "botToken", "Bot token");
      requireField(config, "chatId", "Chat ID");
      break;
    case NOTIFICATION_TYPES.APPRISE:
      if (!config.configKey && !config.serviceUrls) {
        throw new Error("Apprise config key or service URLs are required");
      }
      break;
    default:
      break;
  }
}

export function normalizeNotificationChannelInput(body = {}, existing = null) {
  const name = stringValue(body.name ?? existing?.name);
  const type = stringValue(body.type ?? existing?.type).toLowerCase();
  if (!name) throw new Error("Name is required");
  if (!TYPE_VALUES.has(type)) throw new Error("Unsupported notification type");

  const providedConfig = normalizeConfig(type, body.config || {});
  const previousConfig = existing?.type === type ? existing.config || {} : {};
  const config = { ...previousConfig, ...providedConfig };
  for (const field of SECRET_CONFIG_FIELDS[type] || []) {
    const provided = providedConfig[field];
    const hasProvidedValue = typeof provided === "string"
      ? provided.length > 0
      : provided && typeof provided === "object"
        ? Object.keys(provided).length > 0
        : Boolean(provided);
    if (!hasProvidedValue && previousConfig[field]) config[field] = previousConfig[field];
  }
  validateConfig(type, config);

  const events = body.events === undefined
    ? normalizeEvents(existing?.events || Object.values(NOTIFICATION_EVENTS))
    : normalizeEvents(body.events);
  if (events.length === 0) throw new Error("Select at least one notification event");

  return {
    name,
    type,
    isActive: booleanValue(body.isActive, existing?.isActive !== false),
    events,
    config,
  };
}

export function redactNotificationChannel(channel) {
  if (!channel) return null;
  const config = { ...(channel.config || {}) };
  const configuredSecrets = {};
  for (const field of SECRET_CONFIG_FIELDS[channel.type] || []) {
    configuredSecrets[field] = Boolean(config[field]);
    delete config[field];
  }
  return { ...channel, config, configuredSecrets };
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

export function isPrivateNotificationHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) === 6) {
    return host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd");
  }
  return false;
}
