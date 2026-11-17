import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { buildSamlAuthorizeUrl, getSamlBaseUrl } from "@/lib/auth/saml.js";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { getConfiguredSsoType } from "@/lib/auth/authMode.js";
import { checkRateLimit, getClientIp } from "@/lib/auth/loginLimiter";

// Each call stores a pending request ID, so one client can't flood the store.
const SAML_START_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

export async function GET(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  try {
    if (getConfiguredSsoType(settings) !== "saml") {
      return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin));
    }

    if (checkRateLimit(`saml-start:${getClientIp(request)}`, SAML_START_RATE_LIMIT).limited) {
      return NextResponse.redirect(new URL("/login?error=saml_rate_limited", origin));
    }

    const { authorizeUrl, requestId } = await buildSamlAuthorizeUrl(request, settings);

    const cookieStore = await cookies();
    const secure = shouldUseSecureCookie(request) || new URL(origin).protocol === "https:";
    cookieStore.set("saml_state", requestId, {
      httpOnly: true,
      secure,
      // The IdP posts across sites; Lax would drop the request-binding cookie.
      sameSite: secure ? "none" : "lax",
      path: "/",
      maxAge: 10 * 60,
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message || "saml_start_failed")}`, origin)
    );
  }
}
