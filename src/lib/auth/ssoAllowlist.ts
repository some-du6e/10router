export interface SsoPrincipal {
  subject?: string | null;
  email?: string | null;
  emailVerified?: boolean | string | null;
}

function parseAllowlist(raw: string | undefined): string[] {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// SSO_ALLOWED_USERS: comma-separated emails, "@domain" suffixes, or IdP subjects.
// Unset means every principal the IdP authenticates may sign in.
export function isSsoPrincipalAllowed(principal: SsoPrincipal, raw: string | undefined = process.env.SSO_ALLOWED_USERS): boolean {
  const entries = parseAllowlist(raw);
  if (entries.length === 0) return true;

  const subject = String(principal.subject || "");
  // Email and domain entries need an email the IdP says it verified. Some IdPs
  // send the claim as a string; one that omits it is not vouching for the email.
  const verified = principal.emailVerified === true || principal.emailVerified === "true";
  const email = verified ? String(principal.email || "").trim().toLowerCase() : "";

  return entries.some((entry) => {
    if (subject && entry === subject) return true;
    if (!email) return false;
    const normalized = entry.toLowerCase();
    if (normalized.startsWith("@")) return normalized.length > 1 && email.endsWith(normalized);
    return email === normalized;
  });
}
