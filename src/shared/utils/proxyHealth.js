// What one proxy pool test answer means for the health check. A pool this
// session may not test (a private host from a remote session, `notAllowed`)
// is "skipped": it may route fine, so it is never offered for disabling.
// No node:* imports: the dashboard bundles this file.
export function classifyPoolTest(ok, data) {
  if (data?.notAllowed === true) return "skipped";
  return ok && data?.ok ? "alive" : "dead";
}

export function healthCheckSummary({ alive, dead, skipped }) {
  const base = `Alive: ${alive}, Dead: ${dead}`;
  return skipped ? `${base}, Not tested from this session (private host): ${skipped}` : base;
}
