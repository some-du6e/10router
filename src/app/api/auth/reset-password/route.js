import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { setMeta } from "@/lib/db/helpers/metaStore.js";
import { LEGACY_GRACE_META_KEY } from "@/lib/auth/setupState";
import { issueSetupToken, printSetupBanner, SETUP_WINDOW_MS } from "@/lib/auth/setupToken";
import { getActiveSsoType, isPasswordLoginDisabled } from "@/lib/auth/authMode.js";

// Clear the stored password and put the instance back into first-run setup:
// a fresh one-time token is minted and printed to the host console. There is no
// default password to fall back to.
// Local-only (enforced by dashboardGuard).
export async function POST() {
  try {
    // With SSO-only login the setup token would be useless: /setup and password
    // login both stay shut. Switch to "Both" so the token works and SSO keeps working.
    const settings = await getSettings();
    const reopenPassword = isPasswordLoginDisabled(settings);
    const ssoType = getActiveSsoType(settings);

    // Order matters, and neither step may be best-effort: if the grace flag
    // survived a cleared hash the instance would report "legacy" — login would
    // accept the old default password while /setup rejected the fresh token.
    // Clearing the flag first means a failure here leaves the current password
    // untouched and mints nothing.
    await setMeta(LEGACY_GRACE_META_KEY, "0");
    await updateSettings(reopenPassword ? { password: null, authMode: "both", ssoType } : { password: null });
    if (reopenPassword) {
      console.log(`[Auth] Password reset: login mode switched from ${ssoType.toUpperCase()} only to password + ${ssoType.toUpperCase()}, so the setup token can be used.`);
    }

    const token = issueSetupToken();
    printSetupBanner(token, { reason: reopenPassword ? "password reset (password login turned back on)" : "password reset" });

    return NextResponse.json({
      success: true,
      token,
      expiresInSec: Math.round(SETUP_WINDOW_MS / 1000),
      ...(reopenPassword ? { authMode: "both" } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
