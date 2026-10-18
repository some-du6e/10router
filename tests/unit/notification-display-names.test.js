import { describe, expect, it } from "vitest";
import { buildNotificationMessage, buildWebhookPayload } from "../../src/lib/notifications/message.js";
import { buildSlackPayload } from "../../src/lib/notifications/slackLayout.js";
import { NOTIFICATION_EVENTS } from "../../src/lib/notifications/constants.js";
import { notificationProviderName } from "../../src/lib/notifications/providerName.js";
import { maskEmails } from "../../src/lib/notifications/redact.js";

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

describe("notification privacy and timestamps", () => {
  const event = {
    type: NOTIFICATION_EVENTS.QUOTA_RESET,
    provider: "codex",
    connectionId: "conn-1",
    connectionName: "someone.long@gmail.com",
    quotaName: "session",
    remainingPercentage: 100,
    resetAt: "2026-11-17T04:28:37Z",
  };

  it("masks account emails in every outbound format", () => {
    const message = buildNotificationMessage(event);
    const payload = buildWebhookPayload(event, message);
    const slack = JSON.stringify(buildSlackPayload({}, message, payload));

    expect(message.body).toContain("Account: so••••••••••@gmail.com");
    expect(payload.connection.name).toBe("so••••••••••@gmail.com");
    expect(slack).not.toContain("someone.long");
    expect(slack).toContain("so••••••••••@gmail.com");
  });

  it("masks internationalized addresses too", () => {
    expect(maskEmails("josé@example.com")).toBe("jo•••@example.com");
    expect(maskEmails("user@exämple.de")).toBe("us•••@exämple.de");
  });

  it("leaves non-email account names alone", () => {
    const payload = buildWebhookPayload({ ...event, connectionName: "Work" }, buildNotificationMessage(event));
    expect(payload.connection.name).toBe("Work");
  });

  it("renders reset times as Slack date tokens with a UTC fallback", () => {
    const message = buildNotificationMessage(event);
    const slack = buildSlackPayload({}, message, buildWebhookPayload(event, message));
    const resets = slack.attachments[0].blocks[2].fields[3].text;
    expect(resets).toBe("*Resets*\n<!date^1794889717^{date_short_pretty} at {time}|2026-11-17 04:28:37 UTC>");
  });

  it("still escapes template text around the date token", () => {
    const message = buildNotificationMessage(event);
    const slack = buildSlackPayload(
      { config: { slackLayout: { fields: [{ id: "r", label: "Resets", value: "<{{resetAt}}>" }] } } },
      message,
      buildWebhookPayload(event, message),
    );
    expect(slack.attachments[0].blocks[2].fields[0].text).toMatch(/^\*Resets\*\n&lt;<!date\^\d+\^.*>&gt;$/);
  });
});
