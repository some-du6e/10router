const EMAIL_PATTERN = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

// Account names are usually the OAuth email. Notifications leave this machine
// (Slack, ntfy, webhooks), so keep the first two characters and the domain only.
export function maskEmails(value) {
  if (typeof value !== "string") return value;
  return value.replace(EMAIL_PATTERN, (_, local, domain) => {
    const visible = local.slice(0, Math.min(2, local.length - 1));
    return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
  });
}
