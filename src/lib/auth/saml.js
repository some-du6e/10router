import crypto from "node:crypto";
import { SAML } from "@node-saml/node-saml";
import { isSamlConfigured } from "./authMode.js";
import { getAuthSecret } from "./authSecret.js";

export { isSamlConfigured };

/**
 * Formats a raw Base64 string or unformatted X.509 certificate into standard PEM format.
 * @param {string} certStr
 * @returns {string}
 */
export function formatX509Certificate(certStr) {
  if (!certStr || typeof certStr !== "string") return "";
  const clean = certStr
    .replace(/-----BEGIN CERTIFICATE-----/gi, "")
    .replace(/-----END CERTIFICATE-----/gi, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");

  if (!clean) return "";

  const lines = clean.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/**
 * Creates a configured `@node-saml/node-saml` SAML instance with security defaults.
 * @param {object} settings
 * @param {string} origin
 * @returns {SAML}
 */
const DUMMY_FALLBACK_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIC...DUMMY...\n-----END CERTIFICATE-----";

function trimTrailingSlashes(str) {
  return (str || "").replace(/\/+$/, "");
}

/**
 * Resolves the public Base URL / Origin for SAML requests.
 * Respects settings.baseUrl, process.env.BASE_URL, x-forwarded-proto, and x-forwarded-host.
 * @param {Request} request
 * @param {object} settings
 * @returns {string}
 */
export function getSamlBaseUrl(request, settings) {
  const configuredBaseUrl =
    (settings?.baseUrl || "").trim() ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "";

  if (configuredBaseUrl) {
    return trimTrailingSlashes(configuredBaseUrl);
  }

  if (request) {
    const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
    const forwardedHost = request?.headers?.get?.("x-forwarded-host") || "";
    const host = forwardedHost || request?.headers?.get?.("host") || "";
    if (host) {
      const protocol = (forwardedProto || new URL(request.url).protocol || "http:").replace(/:$/, "");
      return `${protocol}://${host}`.replace(/\/+$/, "");
    }
    if (request.url) {
      return trimTrailingSlashes(new URL(request.url).origin);
    }
  }

  return "http://localhost:20128";
}

export const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;
const CONSUMED_REQUESTS = Symbol.for("10router.samlConsumedRequests");

function signState(payload) {
  return crypto.createHmac("sha256", getAuthSecret()).update(`saml_state\n${payload}`).digest("base64url");
}

// The saml_state cookie holds the AuthnRequest ID and its expiry, signed with the
// server secret. /start keeps no state, and any process with the secret can check it.
export function createSamlStateCookie(requestId, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ id: requestId, exp: now + SAML_REQUEST_TTL_MS })).toString("base64url");
  return `${payload}.${signState(payload)}`;
}

// The request a saml_state cookie names, or null when it is missing, tampered with or expired.
export function readSamlStateCookie(value, now = Date.now()) {
  if (typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(signState(payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const { id, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof id !== "string" || !id || typeof exp !== "number" || exp <= now) return null;
    return { id, exp };
  } catch {
    return null;
  }
}

// Request IDs that signed someone in, or are being checked right now, until their
// cookie would expire. A failed check releases its ID, so only real logins stay.
function consumedRequests() {
  return (globalThis[CONSUMED_REQUESTS] ??= new Map());
}

function claimRequest({ id, exp }, now) {
  const consumed = consumedRequests();
  for (const [key, until] of consumed) if (until <= now) consumed.delete(key);
  if (consumed.has(id)) return false;
  consumed.set(id, exp);
  return true;
}

// node-saml cacheProviders. /start stores nothing; at ACS node-saml may only redeem
// the request the browser's signed cookie names.
const NO_STORE_CACHE = {
  saveAsync: async (key, value) => ({ value, createdAt: Date.now() }),
  getAsync: async () => null,
  removeAsync: async () => null,
};

// node-saml reads the cached value as the request's issue time, the way its own
// store saves it.
function boundRequestCache({ id, exp }) {
  const issuedAt = new Date(exp - SAML_REQUEST_TTL_MS).toISOString();
  return {
    saveAsync: async () => null,
    getAsync: async (key) => (key === id ? issuedAt : null),
    removeAsync: async (key) => key ?? null,
  };
}

export function createSamlInstance(settings, origin, cacheProvider = NO_STORE_CACHE) {
  const cert = formatX509Certificate(settings?.samlCert || "") || DUMMY_FALLBACK_CERT;
  const callbackUrl = `${origin}/api/auth/saml/acs`;
  return new SAML({
    entryPoint: settings?.samlEntryPoint || "https://example.com/sso",
    issuer: settings?.samlIssuer || "urn:9router:sp",
    idpCert: cert,
    cert: cert,
    callbackUrl: callbackUrl,
    acceptedClockSkewMs: 60000,
    wantAssertionsSigned: true,
    validateInResponseTo: "always",
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider,
  });
}

/**
 * Builds the SAML AuthnRequest redirect URL and the signed saml_state cookie value.
 * @param {Request} request
 * @param {object} settings
 * @returns {Promise<{ authorizeUrl: string, requestId: string, stateCookie: string }>}
 */
export async function buildSamlAuthorizeUrl(request, settings) {
  const origin = getSamlBaseUrl(request, settings);
  const samlInstance = createSamlInstance(settings, origin);

  const xml = await samlInstance.generateAuthorizeRequestAsync(false, false);
  const match = xml.match(/ID="([^"]+)"/);
  const requestId = match ? match[1] : "";

  const authorizeUrl = await samlInstance._requestToUrlAsync(xml, null, "authorize", {});

  return { authorizeUrl, requestId, stateCookie: requestId ? createSamlStateCookie(requestId) : "" };
}

/**
 * Validates SAML POST response from IdP ACS callback and returns user profile.
 * @param {Request} request
 * @param {object} body - Parsed form body or object containing SAMLResponse
 * @param {string} stateCookie - The signed saml_state cookie value
 * @param {object} settings
 * @returns {Promise<object>}
 */
export async function validateSamlResponse(request, body, stateCookie, settings) {
  if (!settings?.samlCert) {
    throw new Error("IdP X.509 Certificate (samlCert) is missing or not configured");
  }

  const container = typeof body === "object" && body !== null ? body : { SAMLResponse: body };
  const rawSamlResponse = container.SAMLResponse;

  if (!rawSamlResponse) {
    throw new Error("Missing SAMLResponse parameter in assertion POST body");
  }

  // A response without valid SP-issued request state must never authenticate.
  const pending = readSamlStateCookie(stateCookie);
  if (!pending) {
    throw new Error("Missing, expired or invalid SAML request state; SP-initiated login is required");
  }
  if (!claimRequest(pending, Date.now())) {
    throw new Error("SAML request already used; start a new login");
  }

  let profile;
  try {
    const origin = getSamlBaseUrl(request, settings);
    const samlInstance = createSamlInstance(settings, origin, boundRequestCache(pending));
    const result = await samlInstance.validatePostResponseAsync({ SAMLResponse: rawSamlResponse });
    profile = result?.profile || result;
    const confirmations = profile?.getAssertion?.()?.Assertion?.Subject?.[0]?.SubjectConfirmation || [];
    // Inspect only the assertion parsed from verified XML, never the raw envelope.
    const boundSubject = confirmations.some(confirmation =>
      confirmation.$?.Method === "urn:oasis:names:tc:SAML:2.0:cm:bearer" &&
      confirmation.SubjectConfirmationData?.[0]?.$?.InResponseTo === pending.id
    );
    if (!boundSubject) {
      throw new Error("SAML signed SubjectConfirmation InResponseTo mismatch");
    }
  } catch (error) {
    consumedRequests().delete(pending.id);
    throw error;
  }

  return profile;
}

/**
 * Generates standard SP XML Metadata.
 * @param {string} origin
 * @param {object} settings
 * @returns {string}
 */
export function generateSamlMetadata(origin, settings) {
  const samlInstance = createSamlInstance(settings, origin);
  return samlInstance.generateServiceProviderMetadata();
}

/**
 * Extracts email claim from SAML profile assertion.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
export function pickSamlEmail(profile = {}, settings = {}) {
  if (!profile) return "";

  // 1. Configured custom attribute
  const customAttr = settings.samlAttributeEmail;
  if (customAttr && profile[customAttr]) {
    const val = profile[customAttr];
    return Array.isArray(val) ? val[0] : String(val);
  }

  // 2. Common email claims
  const emailKeys = [
    "email",
    "emailAddress",
    "mail",
    "nameID",
    "nameId",
    "upn",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  ];

  for (const key of emailKeys) {
    if (profile[key]) {
      const val = profile[key];
      return Array.isArray(val) ? val[0] : String(val);
    }
  }

  // 3. Fallback: check attributes object if present
  if (profile.attributes) {
    for (const key of emailKeys) {
      if (profile.attributes[key]) {
        const val = profile.attributes[key];
        return Array.isArray(val) ? val[0] : String(val);
      }
    }
  }

  return "";
}

/**
 * Extracts display name claim from SAML profile assertion.
 * @param {object} profile
 * @param {object} settings
 * @returns {string}
 */
export function pickSamlDisplayName(profile = {}, settings = {}) {
  if (!profile) return "";

  // 1. Configured custom attribute
  const customAttr = settings.samlAttributeName;
  if (customAttr && profile[customAttr]) {
    const val = profile[customAttr];
    return Array.isArray(val) ? val[0] : String(val);
  }

  // 2. Common name claims
  const nameKeys = [
    "displayName",
    "name",
    "cn",
    "commonName",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  ];

  for (const key of nameKeys) {
    if (profile[key]) {
      const val = profile[key];
      return Array.isArray(val) ? val[0] : String(val);
    }
  }

  // 3. Combined givenName + surname
  if (profile.givenName || profile.sn || profile.surname) {
    const given = profile.givenName || "";
    const surname = profile.sn || profile.surname || "";
    const combined = `${given} ${surname}`.trim();
    if (combined) return combined;
  }

  // 4. Fallback to email
  return pickSamlEmail(profile, settings);
}
