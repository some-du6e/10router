import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { codexAccessTokenFields } from "@/lib/oauth/providerHelpers.js";

type SavedConnection = { id: string; provider: string; email?: string | null; name?: string };

/**
 * POST /api/oauth/codex/import-token
 * Import a ChatGPT access token (created from chatgpt.com settings)
 * as a provider connection, bypassing OAuth refresh flow.
 *
 * Body: { accessToken: string, name?: string }
 */
export async function POST(request: Request) {
  try {
    const { accessToken, name } = (await request.json()) as { accessToken?: unknown; name?: unknown };

    if (typeof accessToken !== "string" || !accessToken.trim()) {
      return NextResponse.json(
        { error: "Access token is required" },
        { status: 400 }
      );
    }

    const token = accessToken.trim();

    const { email, providerSpecificData } = codexAccessTokenFields(token);
    const connectionName = (typeof name === "string" && name) || email || "ChatGPT Access Token";

    // Save to database as access_token authType (no refresh token)
    const connection = (await createProviderConnection({
      provider: "codex",
      authType: "access_token",
      accessToken: token,
      name: connectionName,
      email,
      providerSpecificData,
      testStatus: "active",
    })) as unknown as SavedConnection; // the untyped JS repo infers `undefined`

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
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
