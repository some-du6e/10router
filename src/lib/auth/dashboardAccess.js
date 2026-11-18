import { getSettings } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";
import { needsSetup } from "@/lib/auth/setupState";
import { acceptsDashboardSession } from "./authMode.js";

// The rule the proxy applies to dashboard APIs (dashboardGuard.js isAuthenticated),
// for routes that check it again themselves: a session acceptsDashboardSession
// takes, or requireLogin=false on a claimed instance. The proxy also takes the
// CLI token; these routes don't need it.
export async function dashboardSessionAllowed(token) {
  const settings = await getSettings().catch(() => null);
  const setupPending = await needsSetup(settings);
  const session = await getDashboardAuthSession(token);
  if (acceptsDashboardSession(session, settings, setupPending)) return true;
  return !!settings && settings.requireLogin === false && !setupPending;
}
