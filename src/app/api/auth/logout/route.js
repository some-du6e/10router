import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  clearDashboardAuthCookie,
  getDashboardAuthSession,
  revokeDashboardSessions,
} from "@/lib/auth/dashboardSession";

export async function POST() {
  const cookieStore = await cookies();
  // Only a live session may revoke, so an anonymous POST can't log everyone out.
  if (await getDashboardAuthSession(cookieStore.get("auth_token")?.value)) {
    await revokeDashboardSessions();
  }
  clearDashboardAuthCookie(cookieStore);
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
