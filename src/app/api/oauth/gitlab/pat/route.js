import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { isLocalRequest } from "@/dashboardGuard";
import { makeProbeFetch } from "@/lib/probeFetch.js";
import { normalizeGitlabBaseUrl } from "@/lib/oauth/gitlabBaseUrl.js";

/**
 * POST /api/oauth/gitlab/pat
 * Authenticate GitLab Duo with a Personal Access Token (PAT)
 */
export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { token, baseUrl } = body;
    if (!token?.trim()) {
      return NextResponse.json({ error: "Personal Access Token is required" }, { status: 400 });
    }

    const base = normalizeGitlabBaseUrl(baseUrl);
    if (!base) {
      return NextResponse.json({ error: "Invalid GitLab URL" }, { status: 400 });
    }

    // Verify token by fetching current user
    let userRes;
    try {
      userRes = await makeProbeFetch(!isLocalRequest(request))(`${base}/api/v4/user`, {
        headers: { "Private-Token": token.trim(), Accept: "application/json" },
      });
    } catch (error) {
      if (String(error?.message).startsWith("Blocked URL")) {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
      return NextResponse.json({ error: "GitLab URL is not reachable" }, { status: 400 });
    }

    if (!userRes.ok) {
      return NextResponse.json({ error: `GitLab token verification failed (${userRes.status})` }, { status: 401 });
    }

    const user = await userRes.json();
    const email = user.email || user.public_email || "";

    await createProviderConnection({
      provider: "gitlab",
      authType: "oauth",
      accessToken: token.trim(),
      refreshToken: null,
      expiresAt: null,
      email,
      displayName: user.name || user.username || email,
      testStatus: "active",
      providerSpecificData: {
        username: user.username || "",
        email,
        name: user.name || "",
        baseUrl: base,
        authKind: "personal_access_token",
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("GitLab PAT auth error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
