import { notificationFetch } from "../http.js";

export async function sendSlack(channel, message, deps) {
  const text = `*${message.title}*${message.body ? `\n${message.body}` : ""}`;
  await notificationFetch(channel.config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    allowPrivateNetwork: channel.config.allowPrivateNetwork,
  }, deps);
}
