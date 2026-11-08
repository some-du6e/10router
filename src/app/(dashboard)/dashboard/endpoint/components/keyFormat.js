// Formatting for the API key spend views. Budgets are money someone handed
// out, so they read exactly ("$2,000.00"), not compacted ("$2k").

export function fmtUsdExact(value) {
  const n = Number(value) || 0;
  if (n > 0 && n < 0.01) return "<$0.01";
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

/** Bar colour for how much of a budget is gone. */
export function budgetTone(fraction) {
  if (fraction >= 1) return "bg-red-500";
  if (fraction >= 0.8) return "bg-amber-500";
  return "bg-primary";
}
