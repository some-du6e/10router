import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  getSamlBaseUrl,
  isSamlConfigured,
  pickSamlDisplayName,
  pickSamlEmail,
  validateSamlResponse,
} from "@/lib/auth/saml.js";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";

export async function POST(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  const ip = getClientIp(request);

  const lock = checkLock(ip);
  if (lock.locked) {
    // 303: this is a POST handler; /login is GET-only and a 307 would re-POST
    // the SAML body there. Fixed code — the retry timer is not secret, but keep
    // all ACS redirects to stable codes for consistency.
    return NextResponse.redirect(
      new URL(`/login?error=saml_locked&retry_after=${lock.retryAfter}`, origin),
      303
    );
  }

  const cookieStore = await cookies();
  const storedRequestId = cookieStore.get("saml_state")?.value || "";

  // Always clear saml_state cookie after attempt
  cookieStore.delete("saml_state");

  try {
    const formData = await request.formData();
    const SAMLResponse = formData.get("SAMLResponse");

    if (!SAMLResponse) {
      recordFail(ip);
      return NextResponse.redirect(new URL("/login?error=saml_missing_response", origin), 303);
    }

    if (!isSamlConfigured(settings)) {
      recordFail(ip);
      return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin), 303);
    }

    const profile = await validateSamlResponse(request, { SAMLResponse }, storedRequestId, settings);

    const samlEmail = pickSamlEmail(profile, settings) || null;
    const samlName = pickSamlDisplayName(profile, settings) || "SAML user";

    recordSuccess(ip);

    await setDashboardAuthCookie(cookieStore, request, {
      saml: true,
      samlEmail,
      samlName,
    });

    return NextResponse.redirect(new URL("/dashboard", origin), 303);
  } catch (error) {
    // Do not reflect error.message into the URL — validateSamlResponse builds
    // messages that include the expected request ID, and library errors can
    // expose config detail. Log server-side, redirect with a fixed code.
    recordFail(ip);
    console.error("[saml/acs] assertion validation failed:", error?.message || error);
    return NextResponse.redirect(new URL("/login?error=saml_acs_failed", origin), 303);
  }
}
