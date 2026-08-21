import { notificationFetch } from "../http.js";

export async function sendNtfy(channel, message, deps) {
  const { serverUrl, topic, token, username, password, priority, tags } = channel.config;
  const url = `${serverUrl.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Title": message.title,
  };
  if (priority && priority !== "default") headers.Priority = priority;
  if (tags) headers.Tags = tags;
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (username && password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  await notificationFetch(url, {
    method: "POST",
    headers,
    body: message.body,
    allowPrivateNetwork: channel.config.allowPrivateNetwork,
  }, deps);
}
