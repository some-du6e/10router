export interface SsoPrincipal {
  subject?: string | null;
  email?: string | null;
  emailVerified?: boolean | null;
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
  const email = principal.emailVerified === false ? "" : String(principal.email || "").trim().toLowerCase();

  return entries.some((entry) => {
    if (subject && entry === subject) return true;
    if (!email) return false;
    const normalized = entry.toLowerCase();
    if (normalized.startsWith("@")) return normalized.length > 1 && email.endsWith(normalized);
    return email === normalized;
  });
}
