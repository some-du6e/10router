// next.config.mjs inlines the result into the build as NEXT_PUBLIC_GA_ID, so a
// running server never reads the variable. Anything that isn't a GA4
// measurement ID turns analytics off.
const GA_MEASUREMENT_ID = /^G-[A-Z0-9]+$/;

export function parseGaMeasurementId(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  return GA_MEASUREMENT_ID.test(id) ? id : "";
}
