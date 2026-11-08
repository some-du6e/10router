// Formatting for the API key spend views. Budgets are money someone handed
// out, so they read exactly ("$2,000.00"), not compacted ("$2k").
import { fmtMoney } from "@/shared/utils/formatAmounts.js";

export function fmtUsdExact(value) {
  const n = Number(value) || 0;
  // Below a cent, two decimals would read "$0.00" for a key that did spend.
  if (n > 0 && n < 0.01) return fmtMoney(n);
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ISO timestamp → the value a datetime-local input wants, in local time. */
export function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * What the limits dialog saves. The expiry goes only when the field changed:
 * the field holds minutes, so resending it would drop a stored expiry's seconds
 * and make the dashboard the owner of an expiry a management key set.
 *
 * @param {{ budget: string, models: string[], expiry: string, savedExpiresAt: string|null }} form
 */
export function buildKeyLimitsPayload({ budget, models, expiry, savedExpiresAt }) {
  const trimmed = String(budget ?? "").trim();
  return {
    budgetUsd: trimmed === "" ? null : Number(trimmed),
    allowedModels: models.length ? models : null,
    ...(expiry !== isoToLocalInput(savedExpiresAt) ? { expiresAt: localInputToIso(expiry) } : {}),
  };
}

/** datetime-local value (local time) → ISO, or null when empty/invalid. */
export function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
