// Where /login sends a visitor, from /api/auth/status.

export interface AuthStatus {
  needsSetup?: boolean;
  ssoLoginAvailable?: boolean;
  authenticated?: boolean;
  mustChangePassword?: boolean;
  requireLogin?: boolean;
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
    // The dashboard takes only an SSO session until setup is done (dashboardGuard),
    // and requireLogin=false doesn't open it: show the SSO button.
    return s.authenticated === true && (s.oidcLogin === true || s.samlLogin === true) ? "dashboard" : "login";
  }
  if (s.authenticated === true || s.requireLogin === false) return "dashboard";
  return "login";
}
