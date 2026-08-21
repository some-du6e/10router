import { notificationFetch } from "../http.js";

export async function sendApprise(channel, message, deps) {
  const { apiUrl, configKey, serviceUrls } = channel.config;
  const url = new URL(apiUrl);
  const body = {
    title: message.title,
    body: message.body,
    type: message.severity === "warning" ? "warning" : "success",
  };

  if (configKey) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/notify/${encodeURIComponent(configKey)}`;
  } else {
    body.urls = serviceUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  }

  await notificationFetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    allowPrivateNetwork: channel.config.allowPrivateNetwork,
  }, deps);
}
