import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { getSettings, updateSettings } from "@/lib/localDb";
import { getBootstrapSecret } from "@/lib/auth/setupState";
import { getAuthSecret } from "@/lib/auth/authSecret.js";

const SECRET = new TextEncoder().encode(getAuthSecret());

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto");
  const isHttpsRequest = forwardedProto === "https";
  return forceSecureCookie || isHttpsRequest;
}

async function currentSessionEpoch() {
  const settings = await getSettings();
  return typeof settings?.sessionEpoch === "string" ? settings.sessionEpoch : null;
}

export async function createDashboardAuthToken(claims = {}) {
  const epoch = await currentSessionEpoch();
  return new SignJWT({ authenticated: true, ...claims, ...(epoch ? { sep: epoch } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
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
  await updateSettings({ sessionEpoch: crypto.randomBytes(16).toString("hex") });
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
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
