import { notificationFetch } from "../http.js";

const BLOCKED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

export async function sendWebhook(channel, message, deps, payload) {
  const headers = { "Content-Type": "application/json" };
  for (const [key, value] of Object.entries(channel.config.headers || {})) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase())) headers[key] = value;
  }
  if (channel.config.bearerToken) headers.Authorization = `Bearer ${channel.config.bearerToken}`;

  await notificationFetch(channel.config.url, {
    method: channel.config.method || "POST",
    headers,
    body: JSON.stringify(payload),
    allowPrivateNetwork: channel.config.allowPrivateNetwork,
  }, deps);
}
