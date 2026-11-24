import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { describeRedirect, makeProbeFetch } from "@/lib/probeFetch.js";
import { resolveGitlabBase } from "@/lib/oauth/gitlabBaseUrl.js";
import { isBlockedUrlError } from "@/shared/utils/ssrfGuard.js";
import { PRIVATE_URL_ERROR } from "@/lib/network/privateUrls.js";

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

    const target = await resolveGitlabBase(request, baseUrl);
    if ("error" in target) {
      return NextResponse.json({ error: target.error }, { status: 400 });
    }
    const { base, remote } = target;

    // Verify token by fetching current user
    let userRes;
    try {
      userRes = await makeProbeFetch(remote)(`${base}/api/v4/user`, {
        headers: { "Private-Token": token.trim(), Accept: "application/json" },
      });
    } catch (error) {
      if (isBlockedUrlError(error)) {
        return NextResponse.json({ error: PRIVATE_URL_ERROR }, { status: 400 });
      }
      return NextResponse.json({ error: "GitLab URL is not reachable" }, { status: 400 });
    }

    if (!userRes.ok) {
      return NextResponse.json({ error: describeRedirect(userRes) || `GitLab token verification failed (${userRes.status})` }, { status: 401 });
    }

    const user = await userRes.json();
    const email = user.email || user.public_email || "";

    const connection = await createProviderConnection({
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

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
    });
  } catch (error) {
    console.error("GitLab PAT auth error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
