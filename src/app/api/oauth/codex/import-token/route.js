import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { extractCodexAccountInfo, decodeJwtPayload } from "@/lib/oauth/providerHelpers.js";

/**
 * POST /api/oauth/codex/import-token
 * Import a ChatGPT access token (created from chatgpt.com settings)
 * as a provider connection, bypassing OAuth refresh flow.
 *
 * Body: { accessToken: string, name?: string }
 */
export async function POST(request) {
  try {
    const { accessToken, name } = await request.json();

    if (typeof accessToken !== "string" || !accessToken.trim()) {
      return NextResponse.json(
        { error: "Access token is required" },
        { status: 400 }
      );
    }

    const token = accessToken.trim();

    const info = extractCodexAccountInfo(token);
    const email = info.email || null;
    const providerSpecificData = { authMethod: "access_token" };
    if (info.chatgptAccountId) providerSpecificData.chatgptAccountId = info.chatgptAccountId;
    if (info.chatgptPlanType) providerSpecificData.chatgptPlanType = info.chatgptPlanType;
    const payload = decodeJwtPayload(token);
    if (payload?.exp) providerSpecificData.jwtExp = payload.exp;

    const connectionName = name || email || "ChatGPT Access Token";

    // Save to database as access_token authType (no refresh token)
    const connection = await createProviderConnection({
      provider: "codex",
      authType: "access_token",
      accessToken: token,
      name: connectionName,
      email: email,
      providerSpecificData,
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        name: connection.name,
        workspace: providerSpecificData.chatgptAccountId || null,
        plan: providerSpecificData.chatgptPlanType || null,
      },
    });
  } catch (error) {
    console.log("Codex access token import error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
