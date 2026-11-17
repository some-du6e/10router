import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { setMeta } from "@/lib/db/helpers/metaStore.js";
import { getEnvInitialPassword, LEGACY_GRACE_META_KEY } from "@/lib/auth/setupState";
import { revokeDashboardSessions } from "@/lib/auth/dashboardSession";
import { issueSetupToken, printSetupBanner, SETUP_WINDOW_MS } from "@/lib/auth/setupToken";
import { getConfiguredSsoType, isPasswordLoginDisabled } from "@/lib/auth/authMode.js";

// Clear the stored password. Without INITIAL_PASSWORD this puts the instance back
// into first-run setup: a fresh one-time token is minted and printed to the host
// console. There is no default password to fall back to.
// Local-only (enforced by dashboardGuard).
export async function POST() {
  try {
    const settings = await getSettings();
    const envPassword = getEnvInitialPassword();
    // Password login is really off only when the selected SSO protocol is configured.
    const ssoType = getConfiguredSsoType(settings);
    const ssoOnly = isPasswordLoginDisabled(settings) && ssoType !== null;
    const ssoLabel = ssoType ? ssoType.toUpperCase() : "SSO";
    // With SSO-only login a setup token is useless: /setup and password login
    // stay shut. Turn password login back on ("Both"), unless INITIAL_PASSWORD
    // is set: then "Both" would make it a live password, so the mode stays.
    const switchToBoth = ssoOnly && !envPassword;

    // Order matters, and neither step may be best-effort: if the grace flag
    // survived a cleared hash the instance would report "legacy" — login would
    // accept the old default password while /setup rejected the fresh token.
    // Clearing the flag first means a failure here leaves the current password
    // untouched and mints nothing.
    await setMeta(LEGACY_GRACE_META_KEY, "0");
    await updateSettings(switchToBoth ? { password: null, authMode: "both", ssoType } : { password: null });
    // Sessions signed in with the old password end here. SSO users sign in again.
    await revokeDashboardSessions();

    let message;
    if (envPassword && ssoOnly) {
      message = `Password cleared. Login mode is unchanged: ${ssoLabel} only, password login off. INITIAL_PASSWORD is set, so no setup token is needed; it confirms sensitive actions, and it becomes the login password only if password login is turned back on (Both, or CLI → Settings → Reset Auth Mode).`;
    } else if (envPassword) {
      message = "Password cleared. INITIAL_PASSWORD is set: password login uses it, so no setup token is needed.";
    } else if (switchToBoth) {
      message = `Password cleared. Login mode switched from ${ssoLabel} only to password + ${ssoLabel}, so the setup token works: finish at /setup. ${ssoLabel} sign-in keeps working on the login page meanwhile.`;
    } else if (ssoType) {
      message = `Password cleared. Finish at /setup with the setup token. ${ssoLabel} sign-in keeps working on the login page meanwhile.`;
    } else {
      message = "Password cleared. Finish at /setup with the setup token.";
    }
    console.log(`[Auth] ${message}`);

    if (envPassword) {
      return NextResponse.json({ success: true, token: null, message });
    }

    const token = issueSetupToken();
    printSetupBanner(token, { reason: switchToBoth ? "password reset; password login turned back on" : "password reset" });

    return NextResponse.json({
      success: true,
      token,
      expiresInSec: Math.round(SETUP_WINDOW_MS / 1000),
      message,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
