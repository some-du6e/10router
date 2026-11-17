import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loginLanding } from "../../src/lib/auth/loginLanding.js";

describe("the login page", () => {
  it("decides where to go through loginLanding, not its own requireLogin check", () => {
    const page = readFileSync(fileURLToPath(new URL("../../src/app/login/page.js", import.meta.url)), "utf8");
    expect(page).toMatch(/loginLanding\(data\)/);
    expect(page).not.toMatch(/requireLogin === false/);
  });
});

describe("where /login sends a visitor", () => {
  it("sends an unclaimed instance to /setup", () => {
    expect(loginLanding({ needsSetup: true })).toBe("setup");
    expect(loginLanding({ needsSetup: true, requireLogin: false })).toBe("setup");
  });

  it("shows the SSO login while setup is pending, even with requireLogin off", () => {
    expect(loginLanding({ needsSetup: true, ssoLoginAvailable: true })).toBe("login");
    expect(loginLanding({ needsSetup: true, ssoLoginAvailable: true, requireLogin: false })).toBe("login");
  });

  it("lets only a session from the configured SSO through to the dashboard while setup is pending", () => {
    const pending = { needsSetup: true, ssoLoginAvailable: true, authenticated: true };
    expect(loginLanding({ ...pending, ssoType: "oidc", oidcLogin: true })).toBe("dashboard");
    expect(loginLanding({ ...pending, ssoType: "saml", samlLogin: true })).toBe("dashboard");
    // These would bounce between /login and the dashboard, which refuses them.
    expect(loginLanding({ ...pending, ssoType: "oidc" })).toBe("login");
    expect(loginLanding({ ...pending, ssoType: "saml", oidcLogin: true })).toBe("login");
    expect(loginLanding({ ...pending, ssoType: "oidc", samlLogin: true })).toBe("login");
  });

  it("keeps the usual landings once the instance is claimed", () => {
    expect(loginLanding({ authenticated: true, mustChangePassword: true })).toBe("change-password");
    expect(loginLanding({ authenticated: true })).toBe("dashboard");
    expect(loginLanding({ requireLogin: false })).toBe("dashboard");
    expect(loginLanding({})).toBe("login");
    expect(loginLanding(null)).toBe("login");
  });
});
