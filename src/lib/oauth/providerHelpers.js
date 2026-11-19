import { CODEX_AUTH_CLAIM, CODEX_PROFILE_CLAIM } from "./constants/oauth.js";

const BASE64_BLOCK_SIZE = 4;

function validateXaiOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);
  let parsed;
  try { parsed = new URL(value); } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`xai discovery ${field} must use https: ${value}`);
  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }
  return value;
}

function decodeXaiIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

export async function fetchKiroProfileArn(accessToken) {
  if (!accessToken) return null;
  try {
    const response = await fetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}

const claimString = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The identity claims one decoded Codex token carries; non-string values are ignored. */
function codexClaims(payload) {
  if (!payload || typeof payload !== "object") return null;
  const auth = payload[CODEX_AUTH_CLAIM] || {};
  const profile = payload[CODEX_PROFILE_CLAIM] || {};
  return {
    sub: claimString(payload.sub),
    email: claimString(payload.email) || claimString(profile.email),
    preferredUsername: claimString(payload.preferred_username),
    chatgptAccountId: claimString(auth.chatgpt_account_id) || claimString(payload.account_id),
    chatgptPlanType: claimString(auth.chatgpt_plan_type) || claimString(payload.plan_type),
  };
}

/**
 * Email, subject, workspace and plan for a Codex account.
 * - Only one decodable token: its claims.
 * - Both name the same `sub`: ID-token claims first, the access token fills gaps.
 * - Both name a `sub` and they differ: the access token's claims, since it is
 *   the credential that gets stored and sent, and `subjectMismatch` is set.
 * - Either lacks a `sub`: the ID token's claims alone, so a token pair that
 *   can't be tied to one user never mixes.
 */
export function extractCodexAccountInfo(idToken, accessToken) {
  const id = codexClaims(decodeJwtPayload(idToken));
  const access = codexClaims(decodeJwtPayload(accessToken));
  const subjectMismatch = !!(id?.sub && access?.sub && id.sub !== access.sub);
  let sources;
  if (!id || !access) sources = [id || access];
  else if (subjectMismatch) sources = [access];
  else if (id.sub && id.sub === access.sub) sources = [id, access];
  else sources = [id];
  const pick = (field) => sources.map((claims) => claims?.[field]).find(Boolean);
  return {
    email: pick("email") || pick("preferredUsername"),
    sub: pick("sub"),
    chatgptAccountId: pick("chatgptAccountId"),
    chatgptPlanType: pick("chatgptPlanType"),
    subjectMismatch,
  };
}

/**
 * Connection fields for a pasted Codex access token: email and providerSpecificData.
 * @param {string} accessToken
 * @returns {{ email: string | null, providerSpecificData: { authMethod: string, chatgptAccountId?: string, chatgptPlanType?: string, jwtExp?: number } }}
 */
export function codexAccessTokenFields(accessToken) {
  const info = extractCodexAccountInfo(null, accessToken);
  const providerSpecificData = { authMethod: "access_token" };
  if (info.chatgptAccountId) providerSpecificData.chatgptAccountId = info.chatgptAccountId;
  if (info.chatgptPlanType) providerSpecificData.chatgptPlanType = info.chatgptPlanType;
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (Number.isFinite(exp)) providerSpecificData.jwtExp = exp;
  return { email: info.email || null, providerSpecificData };
}

export {
  BASE64_BLOCK_SIZE,
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  decodeJwtPayload,
  extractEmailFromAccessToken,
};
