/**
 * Resolves after `ms`, or as soon as `signal` aborts (at once if it already
 * has). Never rejects, and leaves no timer or abort listener behind.
 * @param {number} ms
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<void>}
 */
export function abortableSleep(ms, signal = null) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener?.("abort", done, { once: true });
  });
}
