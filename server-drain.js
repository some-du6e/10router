"use strict";

// Graceful drain for the production server (custom-server.js). On the first
// SIGTERM/SIGINT the server stops taking connections, answers any request that
// still arrives on an open keep-alive socket with a 503, and waits for the
// model requests already running (long SSE streams included) before it exits.
//
// CommonJS with no dependencies: it is copied next to custom-server.js into the
// standalone build, the Docker image and the CLI package, outside Next's
// dependency tracing.

const DEFAULT_DRAIN_TIMEOUT_MS = 180000;
// setTimeout's ceiling; a longer delay fires at once.
const MAX_DRAIN_TIMEOUT_MS = 2147483647;
// A request still uploading its body this long after the drain starts is cut:
// once the server is closed Node no longer enforces requestTimeout.
const DRAIN_BODY_TIMEOUT_MS = 30000;
// `npm run start` forwards the signal it got, and a process-group kill reaches
// both, so one stop can arrive twice. A repeat this soon is not a second ask.
const DUPLICATE_SIGNAL_WINDOW_MS = 1500;
// Grace after the last request ends, so its final bytes leave the socket.
const EXIT_FLUSH_MS = 200;
// Total time the app's own shutdown listeners get to settle their promises.
const LISTENER_WAIT_MS = 2000;
const RETRY_AFTER_SECONDS = 5;
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"];
// Shared with open-sse/utils/shutdownHold.js: work that outlives its response.
const BACKGROUND_WORK_KEY = Symbol.for("10router.server.backgroundWork");

// Model traffic, as the socket sees it (before Next's rewrites to /api/v1*).
// Only these hold the drain; dashboard requests are short or never end.
const MODEL_TRAFFIC = /^\/(?:api\/)?v1(?:beta)?(?:\/|$)|^\/(?:codex|backend-api\/codex)(?:\/|$)|^\/(?:responses|systemone)\/?$/;
// Streams that only end when the client leaves. Closed when the drain starts;
// EventSource reconnects on its own, to the next server.
const LONG_LIVED = [/^\/api\/usage\/stream\/?$/, /^\/api\/translator\/console-logs\/stream\/?$/, /^\/api\/mcp\/[^/]+\/sse\/?$/];

function parseDrainTimeout(value, warn = console.warn) {
  if (value === undefined || value === null) return DEFAULT_DRAIN_TIMEOUT_MS;
  const text = String(value).trim().toLowerCase();
  if (text === "") return DEFAULT_DRAIN_TIMEOUT_MS;
  if (text === "0" || text === "off" || text === "false") return 0;
  if (/^\d+$/.test(text)) return Math.min(Number(text), MAX_DRAIN_TIMEOUT_MS);
  warn(`[Shutdown] SHUTDOWN_DRAIN_TIMEOUT_MS=${JSON.stringify(String(value))} is not a whole number of ms; using ${DEFAULT_DRAIN_TIMEOUT_MS}`);
  return DEFAULT_DRAIN_TIMEOUT_MS;
}

function pathOf(url) {
  const text = String(url || "");
  const end = text.search(/[?#]/);
  return end === -1 ? text : text.slice(0, end);
}

const isModelTraffic = (url) => MODEL_TRAFFIC.test(pathOf(url));
const isLongLived = (url) => LONG_LIVED.some((re) => re.test(pathOf(url)));

function backgroundWork() {
  return (globalThis[BACKGROUND_WORK_KEY] ||= { count: 0, onChange: null });
}

function createDrain({
  timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  exit,
  log = console.log,
  bodyTimeoutMs = DRAIN_BODY_TIMEOUT_MS,
  duplicateWindowMs = DUPLICATE_SIGNAL_WINDOW_MS,
  flushMs = EXIT_FLUSH_MS,
} = {}) {
  let exitFn = exit;
  const servers = new Set();
  const active = new Set(); // { req, end } per model request in flight
  const longLived = new Set();
  let holds = 0;
  let draining = false;
  let finished = false;
  let startedAt = 0;
  let drainSignal = null;
  let timer = null;
  let bodyTimer = null;
  let flushTimer = null;

  const open = () => active.size + holds + Math.max(0, backgroundWork().count);
  const seconds = (ms) => Math.round(ms / 1000);

  function closeIdle() {
    for (const server of servers) {
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    }
  }

  function finish(code, info) {
    if (finished) return;
    finished = true;
    for (const t of [timer, bodyTimer, flushTimer]) if (t) clearTimeout(t);
    timer = bodyTimer = flushTimer = null;
    if (backgroundWork().onChange === changed) backgroundWork().onChange = null;
    exitFn(code, info);
  }

  function scheduleFinish() {
    if (!draining || finished || flushTimer || open() > 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (open() > 0) return;
      log(`[Shutdown] drained in ${seconds(Date.now() - startedAt)}s, exiting`);
      finish(0, { reason: "drained", open: 0, signal: drainSignal });
    }, flushMs);
  }

  function changed() {
    if (!draining) return;
    closeIdle();
    scheduleFinish();
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

  function cutSlowBodies() {
    let cut = 0;
    for (const entry of [...active]) {
      if (entry.req.complete) continue;
      cut++;
      if (entry.req.socket) entry.req.socket.destroy();
      entry.end();
    }
    if (cut) log(`[Shutdown] closed ${cut} request(s) still sending their body`);
  }

  return {
    get draining() {
      return draining;
    },
    get inflight() {
      return open();
    },
    timeoutMs,

    setExit(fn) {
      exitFn = fn;
    },

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
      if (!isModelTraffic(req.url)) {
        if (isLongLived(req.url)) {
          longLived.add(res);
          res.once("close", () => longLived.delete(res));
        }
        return true;
      }
      let done = false;
      const entry = {
        req,
        end: () => {
          if (done) return;
          done = true;
          active.delete(entry);
          changed();
        },
      };
      active.add(entry);
      res.once("finish", entry.end);
      res.once("close", entry.end);
      return true;
    },

    // Holds the drain open until the returned function is called (once).
    hold() {
      holds++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        holds--;
        changed();
      };
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
        if (Date.now() - startedAt < duplicateWindowMs) return;
        log(`[Shutdown] second ${signal}: exiting now with ${open()} request(s) still open`);
        finish(1, { reason: "signal", open: open(), signal });
        return;
      }
      if (timeoutMs <= 0) {
        finish(0, { reason: "disabled", open: open(), signal });
        return;
      }
      draining = true;
      drainSignal = signal;
      startedAt = Date.now();
      log(
        `[Shutdown] ${signal}: draining ${open()} in-flight request(s), up to ${seconds(timeoutMs)}s; ` +
          "new connections are refused meanwhile (send the signal again to exit now)"
      );
      for (const server of servers) server.close(() => {});
      closeIdle();
      for (const res of [...longLived]) res.destroy();
      backgroundWork().onChange = changed;

      let bodyDeadline = bodyTimeoutMs;
      for (const server of servers) {
        if (server.requestTimeout > 0) bodyDeadline = Math.min(bodyDeadline, server.requestTimeout);
      }
      bodyTimer = setTimeout(() => {
        bodyTimer = null;
        cutSlowBodies();
      }, Math.min(bodyDeadline, timeoutMs));
      timer = setTimeout(() => {
        log(`[Shutdown] drain timed out after ${seconds(timeoutMs)}s with ${open()} request(s) still open, exiting`);
        finish(1, { reason: "timeout", open: open(), signal });
      }, timeoutMs);
      scheduleFinish();
    },
  };
}

/**
 * Route SIGTERM/SIGINT to `onSignal` instead of the process's listeners. The
 * app registers its own (database adapters, request-detail flush, tunnel
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

  // Run the app's own listeners for `signal`, in the order they were added,
  // waiting on each one's promise (all of them within `waitMs`): a flush that
  // awaits the database must land before the listener after it closes it.
  // process.exit() is held off meanwhile, so one listener can't skip the rest;
  // the caller exits once this resolves.
  return async function runSignalListeners(signal, { waitMs = LISTENER_WAIT_MS } = {}) {
    const deadline = Date.now() + waitMs;
    const realExit = proc.exit;
    proc.exit = () => {};
    try {
      for (const listener of proc.listeners(signal)) {
        if (listener === keepAlive) continue;
        try {
          const result = listener.call(proc, signal);
          const left = deadline - Date.now();
          if (result && typeof result.then === "function" && left > 0) {
            let wait;
            await Promise.race([
              Promise.resolve(result).catch((error) => logListenerError(error)),
              new Promise((resolve) => { wait = setTimeout(resolve, left); }),
            ]);
            clearTimeout(wait);
          }
        } catch (error) {
          logListenerError(error);
        }
      }
    } finally {
      proc.exit = realExit;
    }
  };
}

function logListenerError(error) {
  console.error("[Shutdown] shutdown listener failed:", error && error.message ? error.message : error);
}

module.exports = {
  BACKGROUND_WORK_KEY,
  DEFAULT_DRAIN_TIMEOUT_MS,
  MAX_DRAIN_TIMEOUT_MS,
  SHUTDOWN_SIGNALS,
  createDrain,
  gateShutdownSignals,
  isLongLived,
  isModelTraffic,
  parseDrainTimeout,
};
