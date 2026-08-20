import { getSettings } from "@/lib/localDb";
import { generateSamlMetadata, getSamlBaseUrl } from "@/lib/auth/saml";

export async function GET(request) {
  try {
    const settings = await getSettings();
    // Use the same origin resolver the start/acs routes use so the published
    // ACS Location matches the runtime base URL behind a reverse proxy or a
    // configured baseUrl. request.url alone is the loopback origin in those
    // setups and the IdP would post assertions to the wrong host.
    const origin = getSamlBaseUrl(request, settings);
    const metadataXml = generateSamlMetadata(origin, settings);

    return new Response(metadataXml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    // Do not interpolate error.message into XML — library/settings errors can
    // carry internal detail and the body would be unescaped. Fixed body, log
    // the detail server-side.
    console.error("[saml/metadata] failed to generate metadata:", error?.message || error);
    return new Response(`<?xml version="1.0"?><Error>Failed to generate metadata</Error>`, {
      status: 500,
      headers: {
        "Content-Type": "application/xml",
      },
    });
  }
}
