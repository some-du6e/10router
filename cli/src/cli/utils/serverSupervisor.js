// Keeps the launcher's own server child running. Before each start it runs
// preflight (is the port free?). It restarts the child after a crash, gives up
// when the start after maxRestarts restarts also fails quickly, and never
// respawns once shutdown has begun. It only handles the child it spawned: a
// port held by another process is left to that process.
const MAX_RESTARTS = 2;
const RESTART_RESET_MS = 30000; // a run this long counts as healthy

function superviseServer({
  spawn,
  preflight = async () => null,
  isShuttingDown,
  onExit,
  onGiveUp,
  onRestart = () => {},
  // Called with each child right after it is spawned, the first and every
  // restarted one (cli.js re-runs its readiness check there).
  onStart = () => {},
  maxRestarts = MAX_RESTARTS,
  resetMs = RESTART_RESET_MS,
}) {
  let child = null;
  let restarts = 0;

  // Never rejects: a preflight or spawn that throws ends the launcher through
  // onGiveUp, on the first start and on every restart.
  function start() {
    return run().catch((error) => onGiveUp({ reason: "start-failed", error, maxRestarts }));
  }

  async function run() {
    const blocked = await preflight();
    if (isShuttingDown()) return;
    if (blocked) {
      onGiveUp({ reason: "port-taken", error: blocked, maxRestarts });
      return;
    }

    const startedAt = Date.now();
    const current = spawn();
    child = current;
    onStart(current);

    // A failed spawn emits both error and close; act on the first only.
    let ended = false;
    const finish = (code, error) => {
      if (ended) return;
      ended = true;
      if (isShuttingDown()) return onExit(error ? 1 : code || 0);
      if (!error && code === 0) return onExit(0);
      if (Date.now() - startedAt >= resetMs) restarts = 0;
      if (restarts >= maxRestarts) return onGiveUp({ reason: "crash", code, error, maxRestarts });
      restarts++;
      const delay = Math.min(1000 * restarts, 10000);
      onRestart({ code, error, delay, attempt: restarts, maxRestarts });
      setTimeout(() => {
        if (!isShuttingDown()) start();
      }, delay);
    };
    current.on("error", (error) => finish(undefined, error));
    current.on("close", (code) => finish(code));
  }

  return { start, current: () => child };
}

module.exports = { superviseServer, MAX_RESTARTS, RESTART_RESET_MS };
