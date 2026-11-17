// Login-mode resolution with no dependencies, so the request proxy can use it
// without loading the OIDC or SAML libraries.

export type SsoType = "oidc" | "saml";

export interface AuthModeSettings {
  authMode?: string | null;
  ssoType?: string | null;
  oidcIssuerUrl?: string | null;
  oidcClientId?: string | null;
  oidcClientSecret?: string | null;
  samlEntryPoint?: string | null;
  samlCert?: string | null;
}

const trimmed = (value: unknown): string => String(value || "").trim();

export function isOidcConfigured(settings?: AuthModeSettings | null): boolean {
  return !!(
    trimmed(settings?.oidcIssuerUrl).replace(/\/+$/, "") &&
    trimmed(settings?.oidcClientId) &&
    trimmed(settings?.oidcClientSecret)
  );
}

export function isSamlConfigured(settings?: AuthModeSettings | null): boolean {
  return Boolean(settings?.samlEntryPoint && settings?.samlCert);
}

// The SSO protocol the login mode selects, legacy mode names included.
export function getActiveSsoType(settings?: AuthModeSettings | null): SsoType | null {
  const authMode = settings?.authMode;
  if (authMode === "oidc") return "oidc";
  if (authMode === "saml") return "saml";
  if (authMode === "sso" || authMode === "both") {
    return settings?.ssoType === "saml" ? "saml" : "oidc";
  }
  return null;
}

// The selected SSO protocol, only when its settings are filled in.
export function getConfiguredSsoType(settings?: AuthModeSettings | null): SsoType | null {
  const type = getActiveSsoType(settings);
  if (type === "oidc" && isOidcConfigured(settings)) return "oidc";
  if (type === "saml" && isSamlConfigured(settings)) return "saml";
  return null;
}

export function isPasswordLoginDisabled(settings?: AuthModeSettings | null): boolean {
  return settings?.authMode !== "both" && getActiveSsoType(settings) !== null;
}

export interface DashboardSession {
  pwChange?: boolean;
  oidc?: boolean;
  saml?: boolean;
}

// Whether a dashboard session may act on the dashboard (pages and API). A
// forced-password-change session never does. While setup is pending (after
// Reset Password, in any mode) only a session from the SSO protocol configured
// right now does: a password session from before the reset, or an OIDC session
// after a switch to SAML, doesn't.
export function acceptsDashboardSession(
  session: DashboardSession | null | undefined,
  settings: AuthModeSettings | null | undefined,
  setupPending: boolean,
): boolean {
  if (!session || session.pwChange === true) return false;
  if (!setupPending) return true;
  const type = getConfiguredSsoType(settings);
  return (type === "oidc" && session.oidc === true) || (type === "saml" && session.saml === true);
}
