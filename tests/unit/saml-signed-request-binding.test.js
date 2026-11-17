import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { SAML } from "@node-saml/node-saml";

// Every process that shares JWT_SECRET can check a saml_state cookie.
vi.stubEnv("JWT_SECRET", "test-secret-for-saml-state-at-least-32-chars");
const saml = await import("../../src/lib/auth/saml.js");

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
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

function verify(body, stateCookie, module = saml, Saml = SAML) {
  // Supply an ephemeral RSA key to the real signature verifier; XML verification stays real.
  vi.spyOn(Saml.prototype, "getKeyInfosAsPem").mockResolvedValue([publicKey]);
  return module.validateSamlResponse(null, body, stateCookie, settings);
}

// The router's process-wide state lives on globalThis under 10router.* symbols.
function ownGlobals() {
  return Object.getOwnPropertySymbols(globalThis).filter((key) => key.description?.startsWith("10router."));
}

// How much each 10router.* global holds (entries of a Map or Set, else its JSON length).
function globalSizes() {
  return Object.fromEntries(ownGlobals().map((key) => {
    const value = globalThis[key];
    const size = typeof value?.size === "number" ? value.size : JSON.stringify(value ?? null)?.length ?? 0;
    return [key.description, size];
  }));
}

async function issueRequest(module = saml) {
  const { requestId, stateCookie } = await module.buildSamlAuthorizeUrl(null, settings);
  expect(requestId).toBeTruthy();
  expect(stateCookie).toBeTruthy();
  return { id: requestId, cookie: stateCookie };
}

describe("cryptographically validated SAML request binding", () => {
  it("accepts a signed Response and Assertion bound to this browser's request", async () => {
    const { id, cookie } = await issueRequest();
    const profile = await verify(response(id), cookie);
    expect(profile.nameID).toBe("user@example.com");
  });

  it("rejects a captured signed response with a forged binding in an unsigned XML comment", async () => {
    const old = await issueRequest();
    const current = await issueRequest();
    const captured = response(old.id, old.id, `<!-- InResponseTo="${current.id}" -->`);
    await expect(verify(captured, current.cookie)).rejects.toThrow(/InResponseTo/i);
  });

  it("rejects a signed assertion bound to a different request than its signed Response", async () => {
    const { id, cookie } = await issueRequest();
    await expect(verify(response(id, "other-request"), cookie)).rejects.toThrow(/InResponseTo/i);
  });

  it("rejects a signed assertion missing SubjectConfirmation request binding", async () => {
    const { id, cookie } = await issueRequest();
    await expect(verify(response(id, ""), cookie)).rejects.toThrow(/InResponseTo/i);
  });

  it("rejects a forged or tampered saml_state cookie", async () => {
    const { id, cookie } = await issueRequest();
    const [payload, signature] = cookie.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ id: "attacker-chosen", exp: Date.now() + 60_000 })).toString("base64url");
    for (const bad of ["attacker-chosen", `${forgedPayload}.${signature}`, `${payload}.${signature.slice(0, -2)}xx`, "", undefined]) {
      await expect(verify(response("attacker-chosen"), bad), String(bad)).rejects.toThrow(/request state/);
    }
    // The real login still works afterwards.
    await expect(verify(response(id), cookie)).resolves.toBeTruthy();
  });

  it("rejects a response once its saml_state cookie is more than 10 minutes old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { id, cookie } = await issueRequest();
    vi.setSystemTime(Date.now() + saml.SAML_REQUEST_TTL_MS + 1000);
    await expect(verify(response(id), cookie)).rejects.toThrow(/request state/);
  });

  it("accepts each request once, so a captured response cannot be replayed", async () => {
    const { id, cookie } = await issueRequest();
    const captured = response(id);
    await verify(captured, cookie);
    await expect(verify(captured, cookie)).rejects.toThrow(/already used/);
  });

  it("releases a request whose response failed, so only a real login uses it up", async () => {
    const { id, cookie } = await issueRequest();
    await expect(verify(response(id, "other-request"), cookie)).rejects.toThrow(/InResponseTo/i);
    await expect(verify(response(id), cookie)).resolves.toBeTruthy();
  });

  it("isn't affected by /start being called over and over, and keeps nothing for it", async () => {
    const before = globalSizes();
    const pending = await issueRequest();
    for (let i = 0; i < 500; i++) await saml.buildSamlAuthorizeUrl(null, settings);
    expect(globalSizes()).toEqual(before);
    await expect(verify(response(pending.id), pending.cookie)).resolves.toBeTruthy();
  });

  it("lets another server process with the same secret finish the login", async () => {
    const { id, cookie } = await issueRequest();
    // A second process: fresh modules and none of this one's process-wide state.
    vi.resetModules();
    for (const key of ownGlobals()) delete globalThis[key];
    const other = await import("../../src/lib/auth/saml.js");
    const { SAML: OtherSaml } = await import("@node-saml/node-saml");
    expect(other).not.toBe(saml);
    const profile = await verify(response(id), cookie, other, OtherSaml);
    expect(profile.nameID).toBe("user@example.com");
  });
});
