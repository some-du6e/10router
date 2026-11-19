import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, recordSuccess, getClientKeys, reserveAttempt, releaseAttempt, LOCAL_LOGIN_KEY } from "@/lib/auth/loginLimiter";
import { isLocalRequest, isTunnelHost } from "@/dashboardGuard";
import { getAuthBootstrapState, getBootstrapSecret } from "@/lib/auth/setupState";
import { getConfiguredSsoType, isPasswordLoginDisabled } from "@/lib/auth/authMode.js";

const RESET_HINT = "Forgot password? Run 10router CLI → Settings → Reset Password, then follow what it prints (or sign in with INITIAL_PASSWORD if it's set).";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function tooManyAttempts(retryAfter) {
  return NextResponse.json(
    { error: `Too many failed attempts. Try again in ${retryAfter}s. ${RESET_HINT}`, retryAfter, resetHint: RESET_HINT },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

export async function POST(request) {
  // Logins from this machine share their own bucket: remote clients never land
  // in it, so they can't lock the owner out, and a forwarder that makes a remote
  // client look local (see TRUST_PROXY) still gets limited. A remote login may
  // have two keys (X-Forwarded-For and X-Real-IP); it counts against both.
  const ip = isLocalRequest(request) ? [LOCAL_LOGIN_KEY] : getClientKeys(request);
  const early = checkLock(ip);
  if (early.locked) return tooManyAttempts(early.retryAfter);
  // The attempt is reserved once the body is in, so a client trickling its
  // body in can't hold reservations (and so the key at 429) without failing.
  let password;
  try {
    ({ password } = await request.json());
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const lock = reserveAttempt(ip);
  if (!lock.ok) return tooManyAttempts(lock.retryAfter);
  try {
    const settings = await getSettings();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelHost(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    const storedHash = settings.password;

    if (isPasswordLoginDisabled(settings)) {
      const ssoType = getConfiguredSsoType(settings);
      if (ssoType === "saml") {
        return NextResponse.json({ error: "Password login is disabled. Use SAML SSO sign in." }, { status: 403 });
      }
      if (ssoType === "oidc") {
        return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
      }
    }

    const bootstrapState = await getAuthBootstrapState(settings);

    // Nothing configured yet — there is no default password to guess. The only
    // way in is /setup with the token printed on the host console.
    if (bootstrapState === "setup") {
      return NextResponse.json(
        { error: "Setup required. Complete first-run setup with the token from the server console.", needsSetup: true },
        { status: 403, headers: NO_STORE_HEADERS }
      );
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      // "env" (operator-supplied INITIAL_PASSWORD) or "legacy" (pre-existing
      // install still on the old default) — compared as a plain secret since
      // no hash has ever been stored.
      const secret = await getBootstrapSecret(settings);
      isValid = typeof secret === "string" && typeof password === "string" && password === secret;
    }

    if (isValid) {
      recordSuccess(ip);
      const cookieStore = await cookies();

      // Legacy installs get exactly one login on the old default password, then
      // must set a real one before the dashboard loads. The session issued here
      // carries pwChange, which the guard honours: it unlocks nothing but
      // /api/auth/change-password, so the change cannot be skipped by simply
      // navigating to /dashboard.
      const mustChangePassword = bootstrapState === "legacy";
      if (mustChangePassword) {
        await setDashboardAuthCookie(cookieStore, request, { pwChange: true });
      }

      if (mustChangePassword) {
        // Do NOT issue a session token: a fresh install's default password is
        // public knowledge ("123456"), so handing out a valid JWT would let any
        // remote attacker authenticate and (e.g.) PATCH /api/settings to disable
        // authentication entirely (CVE-2026-56679 class). Require the password
        // to be changed first.
        //
        // NOTE: this intentionally leaves no remote self-service password-change
        // path — the change-password flow (PATCH /api/settings) requires a JWT,
        // which we deliberately withhold. A remote fresh-install user must either
        // change the password from the local machine or set INITIAL_PASSWORD
        // before first launch. This is a deliberate security trade-off, not an
        // oversight: issuing any credential before the default password is
        // rotated re-opens the exact attack chain this branch closes.
        return NextResponse.json(
          { success: false, error: "Default password must be changed before remote access. Change it from the local machine (or set INITIAL_PASSWORD).", mustChangePassword },
          { status: 403, headers: NO_STORE_HEADERS }
        );
      }

      await setDashboardAuthCookie(cookieStore, request);

      return NextResponse.json({ success: true, mustChangePassword: false }, { headers: NO_STORE_HEADERS });
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) return tooManyAttempts(postLock.retryAfter);
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    releaseAttempt(ip);
  }
}
