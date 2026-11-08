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

/** datetime-local value (local time) → ISO, or null when empty/invalid. */
export function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
