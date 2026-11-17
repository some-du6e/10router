// Messages for the ?error= values the SSO routes redirect to /login with.
// Unknown values get a generic message, so a crafted link can't put its own
// text on the login page.

const MESSAGES: Record<string, string> = {
  sso_user_not_allowed: "This account isn't allowed to sign in to this dashboard. Ask the admin to add it to SSO_ALLOWED_USERS.",
  saml_not_configured: "SAML sign-in isn't turned on for this dashboard.",
  saml_missing_response: "The identity provider didn't send a SAML response. Try again.",
  saml_start_failed: "SAML sign-in couldn't start. Try again.",
  saml_acs_failed: "SAML sign-in failed. Try again.",
  oidc_start_failed: "OIDC sign-in couldn't start. Try again.",
  oidc_missing_code: "The identity provider didn't send a sign-in code. Try again.",
  oidc_invalid_state: "This sign-in didn't match one started here. Start again.",
  oidc_not_configured: "OIDC sign-in isn't turned on for this dashboard.",
  oidc_callback_failed: "OIDC sign-in failed. Try again.",
};

const PATTERNS: Array<[RegExp, string]> = [
  [/SAML request state/i, "SAML sign-in has to start from this dashboard, served over HTTPS, and finish within 10 minutes. Start again from this page."],
  [/SAML request already used/i, "This SAML sign-in was already used. Start again from this page."],
  [/InResponseTo/i, "This SAML response doesn't answer the sign-in this browser started. Start again."],
  [/nonce/i, "This OIDC sign-in didn't match one started here. Start again."],
  [/Too many failed attempts/i, "Too many failed sign-in attempts. Wait a few minutes and try again."],
];

export function describeLoginError(value: string | null | undefined): string {
  if (!value) return "";
  if (MESSAGES[value]) return MESSAGES[value];
  for (const [pattern, message] of PATTERNS) if (pattern.test(value)) return message;
  return "Single sign-on failed. Try again.";
}
