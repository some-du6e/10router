/**
 * An executor's own upstream call, reported to chatCore's `onUpstreamAttempt`
 * hook (the contract is on BaseExecutor.execute): the send time right before
 * the call, or 0 when the client has already left, and 0 once it comes back
 * with an error. A hang-up during the call keeps the send time, so it is
 * charged. Executors call `onUpstreamAttempt(0)` themselves while they only
 * prepare (fetch a token or a catalog), since nothing is upstream then.
 */
export async function reportedFetch(onUpstreamAttempt, signal, send) {
  onUpstreamAttempt?.(signal?.aborted ? 0 : Date.now());
  const response = await send();
  if (!response?.ok) onUpstreamAttempt?.(0);
  return response;
}
