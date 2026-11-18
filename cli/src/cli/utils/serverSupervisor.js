// Keeps the launcher's own server child running. It restarts the child after a
// crash, gives up after maxRestarts quick failures in a row, and never respawns
// once shutdown has begun. It only ever handles the child it spawned: a port
// held by some other process is left to that process.
function superviseServer({
  spawn,
  isShuttingDown,
  onExit,
  onGiveUp,
  onRestart = () => {},
  maxRestarts = 2,
  resetMs = 30000,
  now = Date.now,
  schedule = setTimeout,
}) {
  let child = null;
  let startedAt = 0;
  let restarts = 0;

  function restartOrGiveUp(code, error) {
    // A run that stayed up for resetMs counts as healthy.
    if (now() - startedAt >= resetMs) restarts = 0;
    if (restarts >= maxRestarts) {
      onGiveUp({ code, error });
      return;
    }
    restarts++;
    const delay = Math.min(1000 * restarts, 10000);
    onRestart({ code, error, delay, attempt: restarts, maxRestarts });
    schedule(() => {
      if (!isShuttingDown()) start();
    }, delay);
  }

  function start() {
    startedAt = now();
    const current = spawn();
    child = current;
    // A failed spawn emits both error and close; act on the first only.
    let ended = false;
    current.on("error", (err) => {
      if (ended) return;
      ended = true;
      if (isShuttingDown()) onExit(1, err);
      else restartOrGiveUp(undefined, err);
    });
    current.on("close", (code) => {
      if (ended) return;
      ended = true;
      if (isShuttingDown() || code === 0) onExit(code || 0);
      else restartOrGiveUp(code);
    });
    return current;
  }

  return { start, current: () => child };
}

module.exports = { superviseServer };
