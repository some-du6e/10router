import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getActiveSsoType, isPasswordLoginDisabled } from "../../src/lib/auth/authMode.js";

const mocks = vi.hoisted(() => ({ getSettings: vi.fn(), getMeta: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({ getMeta: mocks.getMeta, setMeta: vi.fn() }));
const { getOidcRuntimeConfig } = await import("../../src/lib/auth/oidc.js");
const { getSamlRuntimeConfig } = await import("../../src/lib/auth/saml.js");
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
  it.each([
    ["password", "oidc", null, false, "setup"],
    ["oidc", "saml", "oidc", true, "oidc"],
    ["saml", "oidc", "saml", true, "saml"],
    ["sso", "oidc", "oidc", true, "oidc"],
    ["sso", "saml", "saml", true, "saml"],
    ["both", "oidc", "oidc", false, "oidc"],
    ["both", "saml", "saml", false, "saml"],
  ])("resolves %s with selector %s across bootstrap and SSO runtime", async (authMode, ssoType, activeType, passwordDisabled, bootstrap) => {
    const settings = { ...credentials, authMode, ssoType };
    mocks.getSettings.mockResolvedValue(settings);
    expect(getActiveSsoType(settings)).toBe(activeType);
    expect(isPasswordLoginDisabled(settings)).toBe(passwordDisabled);
    expect(await getAuthBootstrapState(settings)).toBe(bootstrap);
    expect(await getOidcRuntimeConfig()).toEqual(activeType === "oidc" ? expect.objectContaining({ clientId: "client" }) : null);
    expect((await getSamlRuntimeConfig()).configured).toBe(activeType === "saml");
  });

  it("requires setup when selected SSO lacks credentials", async () => {
    expect(await getAuthBootstrapState({ authMode: "sso", ssoType: "saml" })).toBe("setup");
    expect(await getAuthBootstrapState({ authMode: "sso", ssoType: "oidc" })).toBe("setup");
  });
});
