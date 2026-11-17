import { afterEach, describe, it, expect, vi } from "vitest";
import { SAML } from "@node-saml/node-saml";
import {
  createSamlStateCookie,
  formatX509Certificate,
  isSamlConfigured,
  generateSamlMetadata,
  pickSamlEmail,
  pickSamlDisplayName,
  validateSamlResponse,
} from "../../src/lib/auth/saml.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

// Signs the saml_state cookies below; read on first use.
vi.stubEnv("JWT_SECRET", "test-secret-for-saml-state");

describe("SAML 2.0 Auth Engine Utilities", () => {
  describe("formatX509Certificate", () => {
    it("formats raw Base64 string into standard 64-column PEM block", () => {
      const rawBase64 = "MIIC1234567890123456789012345678901234567890123456789012345678901234567890";
      const formatted = formatX509Certificate(rawBase64);
      expect(formatted).toContain("-----BEGIN CERTIFICATE-----");
      expect(formatted).toContain("-----END CERTIFICATE-----");
      expect(formatted).toContain("MIIC123456789012345678901234567890123456789012345678901234567890");
      expect(formatted).toContain("\n1234567890\n");
    });

    it("cleans existing PEM header/footer and extra whitespace", () => {
      const rawPem = `
        -----BEGIN CERTIFICATE-----
        MIIC123456789012345678901234567890123456789012345678901234567890
        1234567890
        -----END CERTIFICATE-----
      `;
      const formatted = formatX509Certificate(rawPem);
      expect(formatted).toContain("-----BEGIN CERTIFICATE-----");
      expect(formatted.match(/BEGIN CERTIFICATE/g)?.length).toBe(1);
    });

    it("returns empty string for null, undefined, or invalid inputs", () => {
      expect(formatX509Certificate(null)).toBe("");
      expect(formatX509Certificate(undefined)).toBe("");
      expect(formatX509Certificate("   ")).toBe("");
    });
  });

  describe("isSamlConfigured", () => {
    it("returns true when entryPoint and cert are non-empty", () => {
      expect(
        isSamlConfigured({
          samlEntryPoint: "https://idp.example.com/sso",
          samlCert: "dummy-cert",
        })
      ).toBe(true);
    });

    it("returns false if entryPoint or cert is missing", () => {
      expect(isSamlConfigured({ samlEntryPoint: "https://idp.example.com/sso" })).toBe(false);
      expect(isSamlConfigured({ samlCert: "dummy-cert" })).toBe(false);
      expect(isSamlConfigured({})).toBe(false);
    });
  });

  describe("generateSamlMetadata", () => {
    it("generates valid SP XML metadata with Entity ID and ACS binding", () => {
      const settings = {
        samlEntryPoint: "https://idp.example.com/sso",
        samlIssuer: "urn:9router:sp",
        samlCert: "MIIC123456789012345678901234567890123456789012345678901234567890",
      };
      const xml = generateSamlMetadata("https://localhost:20127", settings);
      expect(xml).toContain('entityID="urn:9router:sp"');
      expect(xml).toContain('Location="https://localhost:20127/api/auth/saml/acs"');
      expect(xml).toContain('WantAssertionsSigned="true"');
    });
  });

  describe("InResponseTo Replay Validation", () => {
    afterEach(() => vi.restoreAllMocks());

    // node-saml has verified the signature; what's left is the binding inside the signed assertion.
    function verifiedProfile(subjectConfirmation) {
      vi.spyOn(SAML.prototype, "validatePostResponseAsync").mockResolvedValue({
        profile: {
          nameID: "user@example.com",
          inResponseTo: "req-123",
          getAssertion: () => ({ Assertion: { Subject: [{ SubjectConfirmation: subjectConfirmation }] } }),
        },
      });
    }
    const body = { SAMLResponse: Buffer.from('<Response InResponseTo="req-123"></Response>').toString("base64") };
    const bearer = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
    // A failed check releases its request, so these can share one.
    const state = () => createSamlStateCookie("req-123");

    it("throws when the verified assertion has no SubjectConfirmation bound to the request", async () => {
      verifiedProfile(undefined);
      await expect(
        validateSamlResponse(null, body, state(), { samlCert: "dummy-cert" })
      ).rejects.toThrow("SAML signed SubjectConfirmation InResponseTo mismatch");
    });

    it("throws when the verified assertion's SubjectConfirmation answers another request", async () => {
      verifiedProfile([{ $: { Method: bearer }, SubjectConfirmationData: [{ $: { InResponseTo: "wrong-id" } }] }]);
      await expect(
        validateSamlResponse(null, body, state(), { samlCert: "dummy-cert" })
      ).rejects.toThrow("SAML signed SubjectConfirmation InResponseTo mismatch");
    });

    it("throws when the matching SubjectConfirmation isn't a bearer confirmation", async () => {
      verifiedProfile([{ $: { Method: "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key" }, SubjectConfirmationData: [{ $: { InResponseTo: "req-123" } }] }]);
      await expect(
        validateSamlResponse(null, body, state(), { samlCert: "dummy-cert" })
      ).rejects.toThrow("SAML signed SubjectConfirmation InResponseTo mismatch");
    });

    it("throws error if samlCert is not configured", async () => {
      const rawXml = Buffer.from('<Response ID="123"></Response>').toString("base64");
      await expect(
        validateSamlResponse(null, { SAMLResponse: rawXml }, state(), {})
      ).rejects.toThrow(/Certificate/);
    });

    it("returns the profile when the bearer SubjectConfirmation answers this request", async () => {
      verifiedProfile([{ $: { Method: bearer }, SubjectConfirmationData: [{ $: { InResponseTo: "req-123" } }] }]);
      const profile = await validateSamlResponse(null, body, state(), { samlCert: "dummy-cert" });
      expect(profile.nameID).toBe("user@example.com");
    });
  });

  describe("Claims Extraction", () => {
    const mockProfile = {
      email: "user@example.com",
      displayName: "Jane Doe",
      "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": ["custom@example.com"],
      customEmail: "custom-email@example.com",
      customName: "Custom User",
    };

    it("pickSamlEmail extracts custom attribute or common claims", () => {
      expect(pickSamlEmail(mockProfile, {})).toBe("user@example.com");
      expect(
        pickSamlEmail(mockProfile, { samlAttributeEmail: "customEmail" })
      ).toBe("custom-email@example.com");
      expect(
        pickSamlEmail(
          { "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": ["custom@example.com"] },
          {}
        )
      ).toBe("custom@example.com");
    });

    it("pickSamlDisplayName extracts custom attribute, common names, or falls back to email", () => {
      expect(pickSamlDisplayName(mockProfile, {})).toBe("Jane Doe");
      expect(
        pickSamlDisplayName(mockProfile, { samlAttributeName: "customName" })
      ).toBe("Custom User");
      expect(
        pickSamlDisplayName({ email: "user@example.com" }, {})
      ).toBe("user@example.com");
      expect(
        pickSamlDisplayName({ givenName: "Alice", surname: "Smith" }, {})
      ).toBe("Alice Smith");
    });
  });

  describe("Settings Repository Defaults", () => {
    it("mergeWithDefaults safely populates SAML defaults for existing installations", () => {
      const merged = mergeWithDefaults({ authMode: "password" });
      expect(merged.ssoType).toBe("oidc");
      expect(merged.samlIssuer).toBe("urn:9router:sp");
      expect(merged.samlLoginLabel).toBe("Sign in with SAML SSO");
      expect(merged.samlAttributeEmail).toBe("email");
      expect(merged.samlAttributeName).toBe("name");
    });
  });
});
