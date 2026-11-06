// Resolve legacy mode names and the dashboard's SSO selector in one place.
export function getActiveSsoType(settings = {}) {
  if (settings.authMode === "oidc") return "oidc";
  if (settings.authMode === "saml") return "saml";
  if (settings.authMode === "sso" || settings.authMode === "both") {
    return settings.ssoType === "saml" ? "saml" : "oidc";
  }
  return null;
}

export function isPasswordLoginDisabled(settings = {}) {
  return settings.authMode !== "both" && getActiveSsoType(settings) !== null;
}
