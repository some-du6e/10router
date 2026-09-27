import { describe, expect, it } from "vitest";
import { buildNotificationMessage, buildWebhookPayload } from "../../src/lib/notifications/message.js";
import { buildSlackPayload } from "../../src/lib/notifications/slackLayout.js";
import { NOTIFICATION_EVENTS } from "../../src/lib/notifications/constants.js";
import { notificationProviderName } from "../../src/lib/notifications/providerName.js";

describe("notification display names", () => {
  it("uses Codex quota reset in Slack text, heading, and a display name in fields", () => {
    const event = { type: NOTIFICATION_EVENTS.QUOTA_RESET, provider: "codex" };
    const message = buildNotificationMessage(event);
    const payload = buildWebhookPayload(event, message);
    const slack = buildSlackPayload({}, message, payload);

    expect(message.title).toBe("Codex quota reset");
    expect(payload.provider).toBe("codex");
    expect(slack.text).toBe("Codex quota reset");
    expect(slack.attachments[0].blocks[1].text.text).toMatch(/^\*Codex quota reset\*/);
    expect(slack.attachments[0].blocks[2].fields[0].text).toBe("*Provider*\nCodex");
  });

  it("preserves registry spelling and unknown custom provider names", () => {
    expect(notificationProviderName("openai")).toBe("OpenAI");
    expect(notificationProviderName("My custom provider")).toBe("My custom provider");
    expect(notificationProviderName(null)).toBe("Provider");
  });

  it("keeps the test notification title", () => {
    expect(buildNotificationMessage({ type: NOTIFICATION_EVENTS.TEST }).title).toBe("10router test notification");
  });
});
