// Work that outlives its HTTP response but should still finish before a
// graceful shutdown exits (server-drain.js at the repo root counts it). The
// counter lives on globalThis so the drain, loaded outside Next's bundle, sees
// the same one. Fail-open: a failure here never affects the request.
const BACKGROUND_WORK_KEY = Symbol.for("10router.server.backgroundWork");

/** Count one piece of work; call the returned function (once) when it ends. */
export function holdShutdown() {
  try {
    const work = (globalThis[BACKGROUND_WORK_KEY] ||= { count: 0, onChange: null });
    work.count++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      work.count--;
      try { work.onChange?.(); } catch { /* the drain's problem, not the request's */ }
    };
  } catch {
    return () => {};
  }
}
