import { notificationFetch } from "../http.js";
import { buildSlackPayload } from "../slackLayout.js";

export async function sendSlack(channel, message, deps, payload) {
  await notificationFetch(channel.config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSlackPayload(channel, message, payload)),
    allowPrivateNetwork: channel.config.allowPrivateNetwork,
  }, deps);
}
