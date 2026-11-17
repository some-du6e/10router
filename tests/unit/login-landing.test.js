import { describe, expect, it } from "vitest";
import { loginLanding } from "../../src/lib/auth/loginLanding.js";

describe("where /login sends a visitor", () => {
  it("sends an unclaimed instance to /setup", () => {
    expect(loginLanding({ needsSetup: true })).toBe("setup");
    expect(loginLanding({ needsSetup: true, requireLogin: false })).toBe("setup");
  });

  it("shows the SSO login while setup is pending, even with requireLogin off", () => {
    expect(loginLanding({ needsSetup: true, ssoLoginAvailable: true })).toBe("login");
    expect(loginLanding({ needsSetup: true, ssoLoginAvailable: true, requireLogin: false })).toBe("login");
  });

  it("lets only an SSO session through to the dashboard while setup is pending", () => {
    expect(loginLanding({ needsSetup: true, ssoLoginAvailable: true, authenticated: true, oidcLogin: true })).toBe("dashboard");
    expect(loginLanding({ needsSetup: true, ssoLoginAvailable: true, authenticated: true, samlLogin: true })).toBe("dashboard");
    // A password session from before the reset would bounce between /login and the dashboard.
    expect(loginLanding({ needsSetup: true, ssoLoginAvailable: true, authenticated: true })).toBe("login");
  });

  it("keeps the usual landings once the instance is claimed", () => {
    expect(loginLanding({ authenticated: true, mustChangePassword: true })).toBe("change-password");
    expect(loginLanding({ authenticated: true })).toBe("dashboard");
    expect(loginLanding({ requireLogin: false })).toBe("dashboard");
    expect(loginLanding({})).toBe("login");
    expect(loginLanding(null)).toBe("login");
  });
});
