import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ validatePostResponseAsync: vi.fn() }));
vi.mock("@node-saml/node-saml", () => ({
  SAML: class {
    validatePostResponseAsync = mocks.validatePostResponseAsync;
  },
}));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({ getSettings: vi.fn() }));
const { validateSamlResponse } = await import("../../src/lib/auth/saml.js");

const settings = { samlCert: "certificate", baseUrl: "https://dashboard.example.com" };
const body = { SAMLResponse: Buffer.from('<Response InResponseTo="request-123"/>').toString("base64") };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validatePostResponseAsync.mockResolvedValue({ profile: {
    email: "user@example.com",
    inResponseTo: "request-123",
    getAssertion: () => ({ Assertion: { Subject: [{ SubjectConfirmation: [{
      $: { Method: "urn:oasis:names:tc:SAML:2.0:cm:bearer" },
      SubjectConfirmationData: [{ $: { InResponseTo: "request-123" } }],
    }] }] } }),
  } });
});

describe("SAML login request binding", () => {
  it.each(["", undefined, null])("rejects cookieless assertion replay with state %s", async state => {
    await expect(validateSamlResponse(null, body, state, settings)).rejects.toThrow(/Missing SAML request state/);
    expect(mocks.validatePostResponseAsync).not.toHaveBeenCalled();
  });

  it("rejects an assertion bound to another request", async () => {
    await expect(validateSamlResponse(null, body, "other-request", settings)).rejects.toThrow(/InResponseTo mismatch/);
    expect(mocks.validatePostResponseAsync).toHaveBeenCalledWith(body);
  });

  it("returns the signature-verified profile for the matching request", async () => {
    expect(await validateSamlResponse(null, body, "request-123", settings)).toEqual(expect.objectContaining({ email: "user@example.com" }));
    expect(mocks.validatePostResponseAsync).toHaveBeenCalledWith(body);
  });

  it("propagates assertion signature rejection", async () => {
    mocks.validatePostResponseAsync.mockRejectedValue(new Error("Invalid signature"));
    await expect(validateSamlResponse(null, body, "request-123", settings)).rejects.toThrow("Invalid signature");
  });
});
