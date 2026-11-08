import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { SAML } from "@node-saml/node-saml";
import { buildSamlAuthorizeUrl, validateSamlResponse } from "../../src/lib/auth/saml.js";

// Resolve the actual validator's signing dependency without adding a test dependency.
const require = createRequire(import.meta.url);
const { SignedXml } = createRequire(require.resolve("@node-saml/node-saml"))("xml-crypto");
let privateKey;
let publicKey;
const settings = { samlCert: "test-certificate", samlEntryPoint: "https://idp.example.com/sso", samlIssuer: "urn:9router:sp", baseUrl: "https://dashboard.example.com" };

beforeAll(() => {
  ({ privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }));
});
afterEach(() => vi.restoreAllMocks());

function sign(xml, element) {
  const signer = new SignedXml({ privateKey, publicCert: publicKey });
  signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  signer.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  signer.addReference({
    xpath: `//*[local-name()='${element}']`,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.computeSignature(xml);
  return signer.getSignedXml();
}

function response(requestId, subjectRequestId = requestId, comment = "") {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const assertion = sign(`<Assertion xmlns="urn:oasis:names:tc:SAML:2.0:assertion" ID="assertion-123" Version="2.0" IssueInstant="${issuedAt}">
    <Issuer>https://idp.example.com</Issuer>
    <Subject><NameID>user@example.com</NameID><SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><SubjectConfirmationData InResponseTo="${subjectRequestId}" NotOnOrAfter="${expiresAt}" Recipient="https://dashboard.example.com/api/auth/saml/acs"/></SubjectConfirmation></Subject>
    <Conditions NotOnOrAfter="${expiresAt}"><AudienceRestriction><Audience>urn:9router:sp</Audience></AudienceRestriction></Conditions>
    <AuthnStatement AuthnInstant="${issuedAt}"><AuthnContext><AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</AuthnContextClassRef></AuthnContext></AuthnStatement>
  </Assertion>`, "Assertion");
  const xml = sign(`<Response xmlns="urn:oasis:names:tc:SAML:2.0:protocol" ID="response-123" Version="2.0" IssueInstant="${issuedAt}" InResponseTo="${requestId}"><Status><StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></Status>${assertion}</Response>`, "Response");
  return { SAMLResponse: Buffer.from(comment + xml).toString("base64") };
}

function verify(body, expectedRequestId) {
  // Supply an ephemeral RSA key to the real signature verifier; XML verification stays real.
  vi.spyOn(SAML.prototype, "getKeyInfosAsPem").mockResolvedValue([publicKey]);
  return validateSamlResponse(null, body, expectedRequestId, settings);
}

async function issueRequest() {
  const { requestId } = await buildSamlAuthorizeUrl(null, settings);
  expect(requestId).toBeTruthy();
  return requestId;
}

describe("cryptographically validated SAML request binding", () => {
  it("accepts a signed Response and Assertion bound to this request", async () => {
    const id = await issueRequest();
    const profile = await verify(response(id), id);
    expect(profile.nameID).toBe("user@example.com");
  });

  it("rejects a captured signed response with a forged binding in an unsigned XML comment", async () => {
    const oldId = await issueRequest();
    const currentId = await issueRequest();
    const captured = response(oldId, oldId, `<!-- InResponseTo="${currentId}" -->`);
    await expect(verify(captured, currentId)).rejects.toThrow(/InResponseTo/i);
  });

  it("rejects a signed assertion bound to a different request than its signed Response", async () => {
    const id = await issueRequest();
    await expect(verify(response(id, "other-request"), id)).rejects.toThrow(/InResponseTo/i);
  });

  it("rejects a signed assertion missing SubjectConfirmation request binding", async () => {
    const id = await issueRequest();
    await expect(verify(response(id, ""), id)).rejects.toThrow(/InResponseTo/i);
  });

  it("rejects a response whose saml_state cookie names a request this server never issued", async () => {
    await expect(verify(response("attacker-chosen"), "attacker-chosen")).rejects.toThrow(/InResponseTo/i);
  });

  it("accepts each issued request once, so a captured response cannot be replayed", async () => {
    const id = await issueRequest();
    const captured = response(id);
    await verify(captured, id);
    await expect(verify(captured, id)).rejects.toThrow(/InResponseTo/i);
  });
});
