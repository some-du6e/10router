import { describe, expect, it } from "vitest";
import { describeLoginError } from "../../src/lib/auth/loginErrors.js";

describe("login page SSO error messages", () => {
  it("names the allowlist when an SSO account is refused", () => {
    expect(describeLoginError("sso_user_not_allowed")).toMatch(/SSO_ALLOWED_USERS/);
  });

  it.each(["saml_not_configured", "saml_missing_response", "saml_start_failed", "oidc_start_failed", "oidc_invalid_state"])("has a message for %s", (code) => {
    expect(describeLoginError(code)).not.toBe("Single sign-on failed. Try again.");
  });

  it("explains the SAML request-state failures", () => {
    expect(describeLoginError("Missing, expired or invalid SAML request state; SP-initiated login is required")).toMatch(/HTTPS/);
    expect(describeLoginError("SAML request already used; start a new login")).toMatch(/already used/);
    expect(describeLoginError("SAML signed SubjectConfirmation InResponseTo mismatch")).toMatch(/this browser started/);
  });

  it("never echoes text it doesn't know", () => {
    expect(describeLoginError("Your account is suspended, call this number")).toBe("Single sign-on failed. Try again.");
    expect(describeLoginError(null)).toBe("");
  });
});
