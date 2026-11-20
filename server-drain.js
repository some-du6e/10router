"use strict";

// Graceful drain for the production server (custom-server.js). On the first
// SIGTERM/SIGINT the server stops taking connections, answers any request that
// still arrives on an open keep-alive socket with a 503, and waits for the
// model requests already running (long SSE streams included) before it exits.
// installExitRecorder logs an `[Exit]` line for every exit the process makes
// itself, naming the code that called process.exit().
//
// CommonJS with no dependencies: it is copied next to custom-server.js into the
// standalone build, the Docker image and the CLI package, outside Next's
// dependency tracing.

const fs = require("fs");

const DEFAULT_DRAIN_TIMEOUT_MS = 180000;
// setTimeout's ceiling; a longer delay fires at once.
const MAX_DRAIN_TIMEOUT_MS = 2147483647;
// Node's own default for server.requestTimeout, used when a server has none.
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
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

// Model traffic, as the socket sees it (before Next's rewrites to /api/v1*,
// which match case-insensitively). Only these hold the drain; dashboard
// requests are short or never end.
const MODEL_TRAFFIC = /^\/(?:api\/)?v1(?:beta)?(?:\/|$)|^\/(?:codex|backend-api\/codex)(?:\/|$)|^\/(?:responses|systemone)\/?$/i;
// Streams that only end when the client leaves. Closed when the drain starts,
// so they don't hold it; an open dashboard tab may need a reload afterwards.
const LONG_LIVED = [/^\/api\/usage\/stream\/?$/i, /^\/api\/translator\/console-logs\/stream\/?$/i, /^\/api\/mcp\/[^/]+\/sse\/?$/i];

function parseDrainTimeout(value, warn = console.warn) {
  if (value === undefined || value === null) return DEFAULT_DRAIN_TIMEOUT_MS;
  const text = String(value).trim().toLowerCase();
  if (text === "") return DEFAULT_DRAIN_TIMEOUT_MS;
  if (text === "0" || text === "off" || text === "false") return 0;
  if (/^\d+$/.test(text)) return Math.min(Number(text), MAX_DRAIN_TIMEOUT_MS);
  warn(`[Shutdown] SHUTDOWN_DRAIN_TIMEOUT_MS=${JSON.stringify(String(value))} is not a whole number of ms; using ${DEFAULT_DRAIN_TIMEOUT_MS}`);
  return DEFAULT_DRAIN_TIMEOUT_MS;
}

// The path a request target routes to: origin-form (`/v1/x?y`) or absolute-form
// (`http://host/v1/x?y`). The URL parser resolves dot segments (`..`, `%2e%2e`),
// as it does for Next's own request URL; the result is then percent-decoded,
// since Next's route lookup also tries the decoded path (`/api/v%31` → `/api/v1`).
function pathOf(url) {
  let pathname;
  try {
    pathname = new URL(String(url || "/"), "http://n").pathname;
  } catch {
    return "/";
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

const isModelTraffic = (url) => MODEL_TRAFFIC.test(pathOf(url));
const isLongLived = (url) => LONG_LIVED.some((re) => re.test(pathOf(url)));

function backgroundWork() {
  return (globalThis[BACKGROUND_WORK_KEY] ||= { count: 0, onChange: null });
}

function createDrain({
  timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  exit = () => {},
  log = console.log,
  duplicateWindowMs = DUPLICATE_SIGNAL_WINDOW_MS,
  flushMs = EXIT_FLUSH_MS,
} = {}) {
  let exitFn = exit;
  const servers = new Set();
  const active = new Set(); // { req, startedAt, end } per model request in flight
  const longLived = new Set();
  const bodyTimers = new Set();
  let holds = 0;
  let draining = false;
  let finished = false;
  let startedAt = 0;
  let drainSignal = null;
  let timer = null;
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
    for (const t of [timer, flushTimer, ...bodyTimers]) if (t) clearTimeout(t);
    timer = flushTimer = null;
    bodyTimers.clear();
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

  // A request finished during the drain: its keep-alive socket is idle now
  // (server.close() only closed the ones idle at the start).
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

  // Once the server is closed Node stops enforcing requestTimeout, so a client
  // trickling its body could hold the drain open. Enforce it here, from when
  // each request started, as Node would have.
  function guardBody(entry) {
    if (entry.req.complete) return;
    const server = entry.req.socket && entry.req.socket.server;
    const requestTimeout = server ? server.requestTimeout : undefined;
    // 0 means Node never cuts it; the drain's own deadline still does.
    if (requestTimeout === 0) return;
    const limit = requestTimeout > 0 ? requestTimeout : DEFAULT_REQUEST_TIMEOUT_MS;
    const bodyTimer = setTimeout(() => {
      bodyTimers.delete(bodyTimer);
      if (entry.req.complete || !active.has(entry)) return;
      log("[Shutdown] closed a request still sending its body past requestTimeout");
      if (entry.req.socket) entry.req.socket.destroy();
      entry.end();
    }, Math.max(0, entry.startedAt + limit - Date.now()));
    bodyTimers.add(bodyTimer);
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
    // was answered with a 503 here and must not reach the app. `admit` lets a
    // request through during the drain (still counted): this process's own
    // loopback POST for a Codex WebSocket turn that started before it.
    track(req, res, { admit = false } = {}) {
      if (draining && !admit) {
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
        startedAt: Date.now(),
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
      if (draining) guardBody(entry);
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
        if (Date.now() - startedAt < duplicateWindowMs) {
          log(`[Shutdown] ${signal} right after the first signal: already draining, ignored`);
          return;
        }
        log(`[Shutdown] second ${signal}: exiting now with ${open()} request(s) still open`);
        finish(1, { reason: "signal", open: open(), signal });
        return;
      }
      draining = true;
      drainSignal = signal;
      log(
        `[Shutdown] ${signal}: draining ${open()} in-flight request(s), up to ${seconds(timeoutMs)}s; ` +
          "new connections are refused meanwhile (send the signal again to exit now)"
      );
      // After the line: a write that waited on a full pipe must not push the
      // repeat of this signal out of the duplicate window.
      startedAt = Date.now();
      // Also closes the connections idle right now (Node 19+).
      for (const server of servers) server.close(() => {});
      for (const res of [...longLived]) res.destroy();
      for (const entry of active) guardBody(entry);
      backgroundWork().onChange = changed;
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

/**
 * Wire `drain` to the process's shutdown signals. The one place a timeout of
 * 0 is handled: returns false, changing nothing, when the drain is off (a
 * signal then exits at once, as without a drain) or the runtime is Bun: Bun calls signal
 * listeners without going through process.emit, so the gate would never see
 * the signal while still keeping Next's own exit from running.
 */
function installShutdownDrain(proc, drain) {
  if (!(drain.timeoutMs > 0) || (proc.versions && proc.versions.bun)) return false;
  const runSignalListeners = gateShutdownSignals(proc, (signal) => drain.start(signal));
  const realExit = proc.exit;
  drain.setExit((code, info) => {
    // A second signal means now: listeners still run, but nobody waits on them.
    const waitMs = info.reason === "signal" ? 0 : LISTENER_WAIT_MS;
    runSignalListeners(info.signal, { waitMs }).finally(() => realExit.call(proc, code));
  });
  // Next's start-server would add its own SIGTERM/SIGINT cleanup, which only
  // repeats the server.close() the drain does and then exits.
  if (!proc.env.NEXT_MANUAL_SIG_HANDLE) proc.env.NEXT_MANUAL_SIG_HANDLE = "true";
  return true;
}

const mb = (bytes) => Math.round(bytes / 1048576);

// How long one line may wait for room in a full stderr pipe, in all.
const WRITE_BUDGET_MS = 1000;
const WRITE_RETRY_MS = 5;
let pauseCell = null;

function pause(ms) {
  try {
    pauseCell ||= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(pauseCell, 0, 0, ms);
  } catch { /* retry at once */ }
}

/**
 * Write one line to stderr (fd 2) before returning. On Linux process.stdout
 * writes to a pipe (Docker's log stream) asynchronously: once the request log
 * fills it, console.log queues lines in memory, and an exit right after drops
 * the queue, so the line that names the exit is the one lost. stdout is the
 * full pipe then, and a direct write to it would land ahead of the queue, mid
 * line; stderr is its own pipe (and the CLI launcher's crash log). A write that
 * finds it full (EAGAIN) is retried for up to `budgetMs`. Returns false when
 * the whole line didn't get out.
 */
function writeLineSync(line, { writeSync = fs.writeSync, budgetMs = WRITE_BUDGET_MS, now = Date.now, sleep = pause } = {}) {
  let rest = Buffer.from(`${line}\n`, "utf8");
  const deadline = now() + budgetMs;
  try {
    while (rest.length) {
      let written = 0;
      try {
        written = writeSync(2, rest);
      } catch (error) {
        if (!error || error.code !== "EAGAIN") throw error;
      }
      if (written > 0) rest = rest.subarray(written);
      else if (now() >= deadline) return false;
      else sleep(WRITE_RETRY_MS);
    }
    return true;
  } catch {
    return false;
  }
}

// The [Exit] and [Shutdown] lines: written now, or queued as before if fd 2 didn't take them.
function logSync(line, { write = writeLineSync, fallback = console.log } = {}) {
  if (!write(line)) fallback(line);
}

// Frames in a stack taken inside an "exit" listener: the process.exit() call,
// and Node ending the process on an uncaught exception or rejection.
const EXIT_FRAME = /^\s*at (?:\S+\.)?exit \(/;
const FATAL_FRAME = /\b_fatalException\b/;
const REJECTION_FRAME = /\b(?:processPromiseRejections|throwUnhandledRejectionsMode)\b/;
const CALLER_FRAMES = 8;

function exitCause(lines, code) {
  const at = lines.findIndex((line) => EXIT_FRAME.test(line));
  if (at !== -1) return `process.exit() called from:\n${lines.slice(at + 1, at + 1 + CALLER_FRAMES).join("\n")}`;
  const fatal = lines.findIndex((line) => FATAL_FRAME.test(line));
  if (fatal !== -1) {
    const rejection = lines.slice(fatal).some((line) => REJECTION_FRAME.test(line));
    return `${rejection ? "an unhandled promise rejection" : "an uncaught exception"} ended the process (Node prints it above)`;
  }
  // Nonzero with neither: Node ended the process itself, not an empty loop.
  if (code !== 0) return "no process.exit() call: an uncaught exception or a fatal error in Node";
  return "the event loop ran empty: nothing was listening or pending";
}

/**
 * Log how the process ends, so a restart names its cause: one line with the
 * exit code, uptime, memory and the model requests still open, then who called
 * process.exit(). An "exit" listener runs inside that call, so its stack shows
 * the caller. Node's own exit on an uncaught exception or rejection shows as
 * `_fatalException`; with neither frame and code 0 the event loop ran empty.
 * The line goes synchronously to stderr (writeLineSync), so a full stdout pipe
 * can't swallow it. A kill from outside (SIGKILL, the kernel's OOM killer)
 * runs no listener, so a restart with no `[Exit]` line at all points there.
 */
function installExitRecorder(proc, { log = logSync, inflight = () => 0 } = {}) {
  // First, so an "exit" listener that calls process.exit() can't skip it.
  proc.prependListener("exit", (code) => {
    // Throwing here would abort the exit in progress.
    try {
      let memory = "";
      try {
        const usage = proc.memoryUsage();
        memory = `, rss ${mb(usage.rss)} MB, heap ${mb(usage.heapUsed)} MB`;
      } catch { /* not available */ }
      let open = "?";
      try { open = inflight(); } catch { /* unknown */ }
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const lines = String(new Error().stack || "").split("\n");
      Error.stackTraceLimit = limit;
      log(`[Exit] exiting with code ${code} after ${Math.round(proc.uptime())}s with ${open} request(s) open${memory}\n  ${exitCause(lines, code)}`);
    } catch { /* nothing left to report with */ }
  });
}

module.exports = {
  BACKGROUND_WORK_KEY,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DUPLICATE_SIGNAL_WINDOW_MS,
  LISTENER_WAIT_MS,
  MAX_DRAIN_TIMEOUT_MS,
  createDrain,
  gateShutdownSignals,
  installExitRecorder,
  installShutdownDrain,
  isLongLived,
  isModelTraffic,
  logSync,
  parseDrainTimeout,
  writeLineSync,
};
