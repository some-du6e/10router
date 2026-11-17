// Where /login sends a visitor, from /api/auth/status.

export interface AuthStatus {
  needsSetup?: boolean;
  ssoLoginAvailable?: boolean;
  authenticated?: boolean;
  mustChangePassword?: boolean;
  requireLogin?: boolean;
  ssoType?: string;
  oidcLogin?: boolean;
  samlLogin?: boolean;
}

export type LoginLanding = "setup" | "change-password" | "dashboard" | "login";

export function loginLanding(status: AuthStatus | null | undefined): LoginLanding {
  const s = status || {};
  // While setup is pending, a configured SSO login still signs in here.
  if (s.needsSetup === true && s.ssoLoginAvailable !== true) return "setup";
  // A restricted session that reloaded the page stays on the change form.
  if (s.authenticated === true && s.mustChangePassword === true) return "change-password";
  if (s.needsSetup === true) {
    // Until setup is done the dashboard takes only a session from the SSO
    // configured now (acceptsDashboardSession), and requireLogin=false doesn't
    // open it: show the SSO button.
    const ssoSession = (s.ssoType === "oidc" && s.oidcLogin === true) || (s.ssoType === "saml" && s.samlLogin === true);
    return s.authenticated === true && ssoSession ? "dashboard" : "login";
  }
  if (s.authenticated === true || s.requireLogin === false) return "dashboard";
  return "login";
}
