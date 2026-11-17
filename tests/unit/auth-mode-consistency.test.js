import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getActiveSsoType, getConfiguredSsoType, isPasswordLoginDisabled } from "../../src/lib/auth/authMode.js";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), getMeta: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({ getMeta: mocks.getMeta, setMeta: vi.fn() }));
const { getOidcRuntimeConfig } = await import("../../src/lib/auth/oidc.js");
const { getAuthBootstrapState } = await import("../../src/lib/auth/setupState.js");

const credentials = {
  oidcIssuerUrl: "https://idp.example.com", oidcClientId: "client", oidcClientSecret: "secret",
  samlEntryPoint: "https://idp.example.com/saml", samlCert: "cert",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INITIAL_PASSWORD", "");
  mocks.getMeta.mockResolvedValue("0");
});

afterEach(() => vi.unstubAllEnvs());

describe("one interpretation of configured authentication mode", () => {
  // "both" keeps password login on, so with no password it still needs setup
  // (or INITIAL_PASSWORD), the way back in after a password reset.
  it.each([
    ["password", "oidc", null, false, "setup"],
    ["oidc", "saml", "oidc", true, "oidc"],
    ["saml", "oidc", "saml", true, "saml"],
    ["sso", "oidc", "oidc", true, "oidc"],
    ["sso", "saml", "saml", true, "saml"],
    ["both", "oidc", "oidc", false, "setup"],
    ["both", "saml", "saml", false, "setup"],
  ])("resolves %s with selector %s across bootstrap and SSO runtime", async (authMode, ssoType, activeType, passwordDisabled, bootstrap) => {
    const settings = { ...credentials, authMode, ssoType };
    mocks.getSettings.mockResolvedValue(settings);
    expect(getActiveSsoType(settings)).toBe(activeType);
    expect(getConfiguredSsoType(settings)).toBe(activeType);
    expect(isPasswordLoginDisabled(settings)).toBe(passwordDisabled);
    expect(await getAuthBootstrapState(settings)).toBe(bootstrap);
    expect(await getOidcRuntimeConfig()).toEqual(activeType === "oidc" ? expect.objectContaining({ clientId: "client" }) : null);
  });

  it("treats a selected SSO protocol without its settings as not configured", async () => {
    expect(getConfiguredSsoType({ authMode: "sso", ssoType: "saml" })).toBeNull();
    expect(getConfiguredSsoType({ authMode: "sso", ssoType: "oidc", samlEntryPoint: "x", samlCert: "y" })).toBeNull();
    expect(await getAuthBootstrapState({ authMode: "sso", ssoType: "saml" })).toBe("setup");
    expect(await getAuthBootstrapState({ authMode: "sso", ssoType: "oidc" })).toBe("setup");
  });

  it("honours INITIAL_PASSWORD in both mode, where password login is still on", async () => {
    vi.stubEnv("INITIAL_PASSWORD", "a-strong-bootstrap-pw");
    expect(await getAuthBootstrapState({ ...credentials, authMode: "both", ssoType: "oidc" })).toBe("env");
    expect(await getAuthBootstrapState({ ...credentials, authMode: "sso", ssoType: "oidc" })).toBe("oidc");
  });
});
