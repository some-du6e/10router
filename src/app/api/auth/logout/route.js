import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  clearDashboardAuthCookie,
  getDashboardAuthSession,
  revokeDashboardSessions,
} from "@/lib/auth/dashboardSession";
import { needsSetup } from "@/lib/auth/setupState";
import { acceptsDashboardSession } from "@/lib/auth/authMode.js";

// Logging out signs out every browser. Only a session the dashboard itself would
// accept may do that: an anonymous POST, a restricted password-change session, or
// a pre-reset session while setup is pending only clears its own cookie.
async function mayRevokeAll(token) {
  const session = await getDashboardAuthSession(token);
  if (!session) return false;
  const settings = await getSettings().catch(() => null);
  return acceptsDashboardSession(session, settings, await needsSetup(settings));
}

export async function POST() {
  const cookieStore = await cookies();
  if (await mayRevokeAll(cookieStore.get("auth_token")?.value)) {
    await revokeDashboardSessions();
  }
  clearDashboardAuthCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
