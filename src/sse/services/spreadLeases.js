// Ends a key's spread try on `model` (auth.js, claimSpreadProbe) once the key
// has answered there, served or failed, or the attempt ended without an answer
// (client gone, an error that locks nothing): the next try may go out. Kept
// apart from auth.js so request handlers can call it whatever their tests
// replace auth.js with.
export function endSpreadProbe(connectionId, model) {
  const leases = global._authEvents?.spreadLeases;
  if (!leases || !connectionId) return;
  for (const [key, lease] of leases) {
    if (lease.connectionId === connectionId && lease.model === (model ?? null)) leases.delete(key);
  }
}
