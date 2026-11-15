"use strict";

// Graceful drain for the production server (custom-server.js). On the first
// SIGTERM/SIGINT the server stops taking connections, answers any request that
// still arrives on an open keep-alive socket with a 503, and waits for the
// requests already running (long SSE streams included) before it exits.
//
// CommonJS with no dependencies: it is copied next to custom-server.js into the
// standalone build, the Docker image and the CLI package, outside Next's
// dependency tracing.

const DEFAULT_DRAIN_TIMEOUT_MS = 600000;
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"];
const RETRY_AFTER_SECONDS = 5;
// Read by the /api/health route, which runs in this process but in Next's bundle.
const DRAINING_KEY = Symbol.for("10router.server.draining");

function parseDrainTimeout(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_DRAIN_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_DRAIN_TIMEOUT_MS;
  return Math.floor(ms);
}

function isDraining() {
  return globalThis[DRAINING_KEY] === true;
}

function createDrain({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS, exit, log = console.log } = {}) {
  const servers = new Set();
  let inflight = 0;
  let draining = false;
  let finished = false;
  let startedAt = 0;
  let timer = null;

  function closeIdle() {
    for (const server of servers) {
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    }
  }

  function finish(code, info) {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    timer = null;
    exit(code, info);
  }

  function maybeFinish(signal) {
    if (!draining || finished || inflight > 0) return;
    log(`[Shutdown] drained in ${Math.round((Date.now() - startedAt) / 1000)}s, exiting`);
    finish(0, { reason: "drained", open: 0, signal });
  }

  function reject(res) {
    const body = JSON.stringify({
      error: { message: "Server is restarting; retry shortly.", type: "server_error", code: "server_draining" },
    });
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Retry-After": String(RETRY_AFTER_SECONDS),
      Connection: "close",
    });
    res.end(body);
  }

  let drainSignal = null;

  return {
    get draining() {
      return draining;
    },
    get inflight() {
      return inflight;
    },
    timeoutMs,

    addServer(server) {
      servers.add(server);
      server.once("close", () => servers.delete(server));
    },

    // Call at the start of every HTTP request. Returns false when the request
    // was answered with a 503 here and must not reach the app.
    track(req, res) {
      if (draining) {
        reject(res);
        return false;
      }
      inflight++;
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        inflight--;
        if (draining) {
          closeIdle();
          maybeFinish(drainSignal);
        }
      };
      res.once("finish", end);
      res.once("close", end);
      return true;
    },

    // A WebSocket upgrade during the drain gets the same answer as a request.
    rejectUpgrade(socket) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\n" +
          `Retry-After: ${RETRY_AFTER_SECONDS}\r\n` +
          "Connection: close\r\nContent-Length: 0\r\n\r\n"
      );
    },

    start(signal) {
      if (finished) return;
      if (draining) {
        log(`[Shutdown] second ${signal}: exiting now with ${inflight} request(s) still open`);
        finish(1, { reason: "signal", open: inflight, signal });
        return;
      }
      if (timeoutMs <= 0) {
        finish(0, { reason: "disabled", open: inflight, signal });
        return;
      }
      draining = true;
      drainSignal = signal;
      startedAt = Date.now();
      globalThis[DRAINING_KEY] = true;
      log(
        `[Shutdown] ${signal}: draining ${inflight} in-flight request(s), up to ${Math.round(timeoutMs / 1000)}s ` +
          "(send it again to exit now)"
      );
      for (const server of servers) server.close(() => {});
      closeIdle();
      timer = setTimeout(() => {
        log(`[Shutdown] drain timed out after ${Math.round(timeoutMs / 1000)}s with ${inflight} request(s) still open, exiting`);
        finish(1, { reason: "timeout", open: inflight, signal });
      }, timeoutMs);
      maybeFinish(signal);
    },
  };
}

/**
 * Route SIGTERM/SIGINT to `onSignal` instead of the process's listeners. The
 * app registers its own (database adapters, Next's start-server, tunnel
 * cleanup) and several call process.exit() at once, which is what cut every
 * stream on a restart. They still run, through the returned function, once the
 * drain is over.
 *
 * Must run before anything listens for these signals: Node binds the signal
 * handler to `process.emit` when the first listener is added.
 */
function gateShutdownSignals(proc, onSignal) {
  const emit = proc.emit;
  proc.emit = function gatedEmit(event, ...args) {
    if (SHUTDOWN_SIGNALS.includes(event)) {
      onSignal(event);
      return true;
    }
    return emit.call(this, event, ...args);
  };
  // Without a listener Node keeps the default action and kills the process.
  const keepAlive = () => {};
  for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, keepAlive);

  // Run the app's own listeners for `signal`. Each one may end with
  // process.exit(); hold that off so all of them run, and let the caller exit.
  return function runSignalListeners(signal) {
    const realExit = proc.exit;
    proc.exit = () => {};
    try {
      emit.call(proc, signal, signal);
    } catch (error) {
      console.error("[Shutdown] signal listener failed:", error && error.message ? error.message : error);
    } finally {
      proc.exit = realExit;
    }
  };
}

module.exports = {
  DEFAULT_DRAIN_TIMEOUT_MS,
  DRAINING_KEY,
  SHUTDOWN_SIGNALS,
  createDrain,
  gateShutdownSignals,
  isDraining,
  parseDrainTimeout,
};
