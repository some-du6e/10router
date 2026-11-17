import { describe, expect, it } from "vitest";
import { describeLoginError } from "../../src/lib/auth/loginErrors.js";

describe("login page SSO error messages", () => {
  it("names the allowlist when an SSO account is refused", () => {
    expect(describeLoginError("sso_user_not_allowed")).toMatch(/SSO_ALLOWED_USERS/);
  });

  it.each(["saml_not_configured", "saml_missing_response", "saml_rate_limited", "oidc_invalid_state"])("has a message for %s", (code) => {
    expect(describeLoginError(code)).not.toBe("Single sign-on failed. Try again.");
  });

  it("explains a SAML login that lost its request state", () => {
    expect(describeLoginError("Missing SAML request state; SP-initiated login is required")).toMatch(/HTTPS/);
    expect(describeLoginError("SAML signed SubjectConfirmation InResponseTo mismatch")).toMatch(/10 minutes/);
  });

  it("never echoes text it doesn't know", () => {
    expect(describeLoginError("Your account is suspended, call this number")).toBe("Single sign-on failed. Try again.");
    expect(describeLoginError(null)).toBe("");
  });
});
