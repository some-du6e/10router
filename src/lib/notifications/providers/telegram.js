import { notificationFetch } from "../http.js";

export async function sendTelegram(channel, message, deps) {
  const { botToken, chatId, messageThreadId, disableNotification } = channel.config;
  const body = {
    chat_id: chatId,
    text: `${message.title}${message.body ? `\n\n${message.body}` : ""}`,
    disable_notification: disableNotification === true,
  };
  if (messageThreadId) body.message_thread_id = messageThreadId;

  await notificationFetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    allowPrivateNetwork: channel.config.allowPrivateNetwork,
  }, deps);
}
