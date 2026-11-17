import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { buildSamlAuthorizeUrl, getSamlBaseUrl, SAML_REQUEST_TTL_MS } from "@/lib/auth/saml.js";
import { shouldUseSecureCookie } from "@/lib/auth/dashboardSession";
import { getConfiguredSsoType } from "@/lib/auth/authMode.js";

export async function GET(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  try {
    if (getConfiguredSsoType(settings) !== "saml") {
      return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin));
    }

    const { authorizeUrl, stateCookie } = await buildSamlAuthorizeUrl(request, settings);

    const cookieStore = await cookies();
    const secure = shouldUseSecureCookie(request) || new URL(origin).protocol === "https:";
    cookieStore.set("saml_state", stateCookie, {
      httpOnly: true,
      secure,
      // The IdP posts across sites; Lax would drop the request-binding cookie.
      sameSite: secure ? "none" : "lax",
      path: "/",
      maxAge: Math.floor(SAML_REQUEST_TTL_MS / 1000),
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message || "saml_start_failed")}`, origin)
    );
  }
}
