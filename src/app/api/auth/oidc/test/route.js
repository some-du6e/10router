import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { fetchOidcDiscovery, getPublicOrigin, probeOidcClientSecret, sameOidcIssuer } from "@/lib/auth/oidc";
import { dashboardSessionAllowed } from "@/lib/auth/dashboardAccess.js";

export async function POST(request) {
  try {
    const cookieStore = await cookies();
    if (!(await dashboardSessionAllowed(cookieStore.get("auth_token")?.value))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();

    const issuerUrl = String(body.issuerUrl || settings.oidcIssuerUrl || "").trim();
    const clientId = String(body.clientId || settings.oidcClientId || "").trim();
    const scopes = String(body.scopes || settings.oidcScopes || "openid profile email").trim() || "openid profile email";
    const secretInBody = Object.prototype.hasOwnProperty.call(body, "clientSecret");
    // The stored secret only ever goes to the stored issuer's token endpoint: a
    // test against another issuer has to bring its own secret.
    const sameIssuer = !!issuerUrl && sameOidcIssuer(issuerUrl, settings.oidcIssuerUrl);
    if (!secretInBody && !sameIssuer && settings.oidcClientSecret) {
      return NextResponse.json(
        { error: "Enter the client secret to test a different issuer; the saved one is only sent to the saved issuer." },
        { status: 400 }
      );
    }
    const clientSecret = String(secretInBody ? body.clientSecret : settings.oidcClientSecret || "").trim();

    if (!issuerUrl) {
      return NextResponse.json({ error: "Issuer URL is required" }, { status: 400 });
    }
    if (!clientId) {
      return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
    }

    const discovery = await fetchOidcDiscovery(issuerUrl);
    const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`;
    const secretProbe = await probeOidcClientSecret({
      tokenEndpoint: discovery.token_endpoint,
      clientId,
      clientSecret,
      redirectUri,
    });

    if (secretProbe.tested && secretProbe.valid === false) {
      return NextResponse.json({
        ok: false,
        discoveryOk: true,
        clientSecretTested: true,
        clientSecretValid: false,
        issuerUrl,
        clientId,
        scopes,
        redirectUri,
        authorizationEndpoint: discovery.authorization_endpoint || "",
        tokenEndpoint: discovery.token_endpoint || "",
        jwksUri: discovery.jwks_uri || "",
        error: `Discovery loaded, but the client secret is not valid: ${secretProbe.message}`,
      });
    }

    return NextResponse.json({
      ok: true,
      discoveryOk: true,
      clientSecretTested: secretProbe.tested,
      clientSecretValid: secretProbe.valid,
      issuerUrl,
      clientId,
      scopes,
      redirectUri,
      authorizationEndpoint: discovery.authorization_endpoint || "",
      tokenEndpoint: discovery.token_endpoint || "",
      jwksUri: discovery.jwks_uri || "",
      message: secretProbe.message,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "OIDC test failed" }, { status: 500 });
  }
}
