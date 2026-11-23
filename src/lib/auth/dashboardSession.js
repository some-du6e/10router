import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { getSettings } from "@/lib/localDb";
import { getMeta, setMeta } from "@/lib/db/helpers/metaStore.js";
import { SESSION_EPOCH_META_KEY, newSessionEpoch } from "@/lib/db/helpers/sessionEpoch.js";
import { getBootstrapSecret } from "@/lib/auth/setupState";
import { getAuthSecret } from "@/lib/auth/authSecret.js";

const SECRET = new TextEncoder().encode(getAuthSecret());

// How long a dashboard sign-in lasts: both the auth_token cookie's Max-Age and the JWT's exp.
const DASHBOARD_SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
// A restricted (pwChange) session comes from a login on the public legacy default
// password and can be had again the same way, so it stays a browser-session cookie.
const PASSWORD_CHANGE_SESSION_TTL_SEC = 24 * 60 * 60;

const isRestrictedSession = (claims) => claims.pwChange === true;

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

// One indexed _meta read per check. null until the first revocation, so sessions
// issued before epochs existed (no `sep`) stay valid until then.
async function currentSessionEpoch() {
  return await getMeta(SESSION_EPOCH_META_KEY, null);
}

export async function createDashboardAuthToken(claims = {}) {
  const epoch = await currentSessionEpoch();
  const now = Math.floor(Date.now() / 1000);
  const ttl = isRestrictedSession(claims) ? PASSWORD_CHANGE_SESSION_TTL_SEC : DASHBOARD_SESSION_MAX_AGE_SEC;
  return new SignJWT({ authenticated: true, ...claims, ...(epoch ? { sep: epoch } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  return (await getDashboardAuthSession(token)) !== null;
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    const epoch = await currentSessionEpoch();
    if ((payload.sep ?? null) !== epoch) return null;
    return payload;
  } catch {
    return null;
  }
}

// Invalidates every dashboard session issued so far.
export async function revokeDashboardSessions() {
  await setMeta(SESSION_EPOCH_META_KEY, newSessionEpoch());
}

// JWT bookkeeping and the restricted-session flag never carry over to a new session.
const NON_IDENTITY_CLAIMS = new Set(["authenticated", "iat", "exp", "nbf", "sep", "pwChange"]);

// After a revocation, signs the caller back in as the same user (the same
// OIDC/SAML identity claims) under the new epoch. A null session is a no-op.
export async function reissueDashboardSession(cookieStore, request, session) {
  if (!session) return;
  const claims = Object.fromEntries(Object.entries(session).filter(([name]) => !NON_IDENTITY_CLAIMS.has(name)));
  await setDashboardAuthCookie(cookieStore, request, claims);
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    ...(isRestrictedSession(claims) ? {} : { maxAge: DASHBOARD_SESSION_MAX_AGE_SEC }),
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  // No hash stored: only the bootstrap secret (INITIAL_PASSWORD, or the old
  // default on a legacy install) can stand in. Unclaimed installs match nothing.
  const secret = await getBootstrapSecret(settings);
  return typeof secret === "string" && password === secret;
}
