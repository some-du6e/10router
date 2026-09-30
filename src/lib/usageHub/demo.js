// Deliberately separate from provider storage: demo accounts can never route inference.
export const demoAccounts = [
  { id: "demo-codex-plus", provider: "codex", email: "plus@example.test", plan: "plus", used: 24 },
  { id: "demo-codex-pro", provider: "codex", email: "pro@example.test", plan: "pro", used: 68 },
  { id: "demo-codex-exhausted", provider: "codex", email: "exhausted@example.test", plan: "plus", used: 100 },
  { id: "demo-claude-max", provider: "claude", email: "claude@example.test", used: 42 },
].map((account) => ({ ...account, authType: "oauth", isActive: true }));

const stateKey = Symbol.for("10router.usageHubDemo");
const state = () => globalThis[stateKey] ||= new Map();

export function demoResponse(account, operation, data) {
  const reset = state().get(account.id);
  const now = Date.now();
  const iso = (hours) => new Date(now + hours * 3600000).toISOString();
  if (operation === "credits") return { credits: reset ? [] : [{
    id: `credit-${account.id}`, status: "available", reset_type: "codex_rate_limits", expires_at: iso(24),
  }] };
  if (operation === "consume") {
    if (reset) return { code: reset === data.redeem_request_id ? "already_redeemed" : "no_credit" };
    if (data.credit_id !== `credit-${account.id}`) return { code: "no_credit" };
    state().set(account.id, data.redeem_request_id);
    return { code: "reset", windows_reset: 2 };
  }
  const used = reset ? 0 : account.used;
  if (account.provider === "claude") return {
    five_hour: { utilization: used, resets_at: iso(3) },
    seven_day: { utilization: 61, resets_at: iso(96) },
    limits: [{ kind: "weekly_scoped", percent: 19, resets_at: iso(96), scope: { model: { display_name: "Sonnet" } } }],
  };
  return {
    plan_type: account.plan,
    rate_limit: {
      primary_window: { used_percent: used, reset_at: Math.floor(now / 1000) + 10800, limit_window_seconds: 18000 },
      secondary_window: { used_percent: reset ? 0 : 73, reset_at: Math.floor(now / 1000) + 345600, limit_window_seconds: 604800 },
    },
  };
}
