// Canonical form of a subscription plan label.
//
// ChatGPT reports its tier inconsistently ("plus", "chatgpt_plus", "ChatGPT
// Pro"), and a plan typed by hand in the dashboard is freer still, so anything
// that branches on the plan has to canonicalise it first.

// A plan we cannot place still spends real quota, and an account we cannot
// classify should keep working. Both callers want the same answer for an
// unreadable plan: treat it as Plus — counted, and never filtered out.
const FALLBACK_PLAN = "plus";

export function normalizePlan(plan) {
  const normalized = String(plan || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!normalized || normalized === "unknown") return FALLBACK_PLAN;
  // "prolite" before "pro" — the generic match would swallow it.
  if (normalized.includes("prolite")) return "prolite";
  if (normalized.includes("enterprise")) return "enterprise";
  if (normalized.includes("business")) return "business";
  if (normalized.includes("team")) return "team";
  if (normalized.includes("pro")) return "pro";
  if (normalized.includes("plus")) return "plus";
  if (normalized.includes("edu")) return "edu";
  if (normalized.includes("free")) return "free";
  return FALLBACK_PLAN;
}
