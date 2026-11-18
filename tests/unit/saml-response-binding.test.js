import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ validatePostResponseAsync: vi.fn() }));
vi.mock("@node-saml/node-saml", () => ({
  SAML: class {
    validatePostResponseAsync = mocks.validatePostResponseAsync;
  },
}));
vi.stubEnv("JWT_SECRET", "test-secret-for-saml-state-at-least-32-chars");
const { createSamlStateCookie, validateSamlResponse } = await import("../../src/lib/auth/saml.js");

const settings = { samlCert: "certificate", baseUrl: "https://dashboard.example.com" };
const body = { SAMLResponse: Buffer.from("<Response/>").toString("base64") };
let next = 0;

// A signature-verified profile whose bearer SubjectConfirmation answers requestId.
function verifiedFor(requestId) {
  mocks.validatePostResponseAsync.mockResolvedValue({ profile: {
    email: "user@example.com",
    getAssertion: () => ({ Assertion: { Subject: [{ SubjectConfirmation: [{
      $: { Method: "urn:oasis:names:tc:SAML:2.0:cm:bearer" },
      SubjectConfirmationData: [{ $: { InResponseTo: requestId } }],
    }] }] } }),
  } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SAML login request binding", () => {
  it.each(["", undefined, null, "request-123"])("rejects a response without a signed saml_state cookie (%s)", async (state) => {
    verifiedFor("request-123");
    await expect(validateSamlResponse(null, body, state, settings)).rejects.toThrow(/Missing, expired or invalid SAML request state/);
    expect(mocks.validatePostResponseAsync).not.toHaveBeenCalled();
  });

  it("rejects an assertion bound to another request", async () => {
    const id = `request-${next++}`;
    verifiedFor("other-request");
    await expect(validateSamlResponse(null, body, createSamlStateCookie(id), settings)).rejects.toThrow(/InResponseTo mismatch/);
    expect(mocks.validatePostResponseAsync).toHaveBeenCalledWith(body);
  });

  it("returns the signature-verified profile for the matching request, once", async () => {
    const id = `request-${next++}`;
    const cookie = createSamlStateCookie(id);
    verifiedFor(id);
    expect(await validateSamlResponse(null, body, cookie, settings)).toEqual(expect.objectContaining({ email: "user@example.com" }));
    await expect(validateSamlResponse(null, body, cookie, settings)).rejects.toThrow(/already used/);
    expect(mocks.validatePostResponseAsync).toHaveBeenCalledOnce();
  });

  it("propagates assertion signature rejection", async () => {
    mocks.validatePostResponseAsync.mockRejectedValue(new Error("Invalid signature"));
    await expect(validateSamlResponse(null, body, createSamlStateCookie(`request-${next++}`), settings)).rejects.toThrow("Invalid signature");
  });
});
