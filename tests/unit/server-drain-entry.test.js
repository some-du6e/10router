import { afterAll, afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the real custom-server.js entry, with a stand-in for Next's standalone
// server.js beside it, and sends it SIGTERM mid-stream. The stand-in registers
// SIGTERM listeners the way the app does: an async flush (request details),
// then one that closes the database and exits at once (the DB adapters).
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const SERVE = `const server = http.createServer((req, res) => {
  if (req.url === "/v1/slow") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\\n\\n");
    setTimeout(() => res.end("data: last\\n\\n"), 3000);
    return;
  }
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port + " SIG " + process.env.NEXT_MANUAL_SIG_HANDLE));
`;

const dirs = [];
// A directory with custom-server.js, server-drain.js and a stand-in server.js.
function entryDir(serverSource) {
  const dir = mkdtempSync(join(tmpdir(), "10router-drain-entry-"));
  dirs.push(dir);
  copyFileSync(join(repoRoot, "custom-server.js"), join(dir, "custom-server.js"));
  copyFileSync(join(repoRoot, "server-drain.js"), join(dir, "server-drain.js"));
  writeFileSync(join(dir, "server.js"), serverSource);
  return dir;
}

const appDir = entryDir(`const http = require("http");
process.on("SIGTERM", async () => {
  await new Promise((r) => setTimeout(r, 100));
  console.log("async-flush-done");
});
process.on("SIGTERM", () => { console.log("db-closed"); process.exit(0); });
process.on("SIGINT", () => { console.log("db-closed-sigint"); process.exit(0); });
${SERVE}`);
// No signal listeners of its own: without the drain's, Node's default action kills it.
const bareDir = entryDir(`const http = require("http");
${SERVE}`);
// Throws once listening, with nothing to catch it.
const crashDir = entryDir(`const http = require("http");
${SERVE}
server.once("listening", () => setTimeout(() => { throw new Error("boom"); }, 50));`);

const children = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runEntry(env, dir = appDir) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NEXT_MANUAL_SIG_HANDLE;
  const child = spawn(process.execPath, ["custom-server.js"], { cwd: dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.resume();
  const port = new Promise((res, rej) => {
    child.stdout.on("data", () => {
      const match = stdout.match(/PORT (\d+)/);
      if (match) res(Number(match[1]));
    });
    child.once("exit", () => rej(new Error(`server exited before listening: ${stdout}`)));
  });
  const exited = new Promise((res) => child.once("exit", (code, signal) => res({ code, signal })));
  return { child, port, exited, output: () => stdout };
}

// GET /v1/slow; sends `signal` to `child` as soon as the first event arrives.
function streamThenSignal(port, child, signal = "SIGTERM") {
  return new Promise((res) => {
    let text = "";
    http.get({ host: "127.0.0.1", port, path: "/v1/slow", agent: false }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (!text) child.kill(signal);
        text += chunk;
      });
      response.on("end", () => res({ text, complete: true }));
      response.on("error", () => res({ text, complete: false }));
      response.on("aborted", () => res({ text, complete: false }));
    }).on("error", () => res({ text, complete: false }));
  });
}

describe("custom-server.js drain on SIGTERM", () => {
  it("finishes a stream in flight when SIGTERM arrives, then runs the app's listeners and exits 0", async () => {
    const run = runEntry({ SHUTDOWN_DRAIN_TIMEOUT_MS: "20000" });
    const port = await run.port;

    const result = await streamThenSignal(port, run.child);
    const { code } = await run.exited;

    expect(result).toEqual({ text: "data: first\n\ndata: last\n\n", complete: true });
    expect(code).toBe(0);
    const out = run.output();
    // Next's own SIGTERM cleanup is left to the drain.
    expect(out).toContain("SIG true");
    expect(out).toContain("[Shutdown] SIGTERM: draining 1 in-flight request(s)");
    expect(out).toMatch(/\[Shutdown\] drained in \d+s, exiting/);
    // The app's listeners run after the drain, in order, the async one awaited.
    const drained = out.indexOf("drained in");
    expect(out.indexOf("async-flush-done")).toBeGreaterThan(drained);
    expect(out.indexOf("db-closed")).toBeGreaterThan(out.indexOf("async-flush-done"));
    // One [Exit] line, last, from the drain's own exit: the "db-closed"
    // listener's process.exit(0) is held off until the drain exits.
    const lines = out.split("\n");
    const exitAt = lines.findIndex((line) => line.startsWith("[Exit]"));
    expect(lines.filter((line) => line.startsWith("[Exit]"))).toHaveLength(1);
    expect(lines[exitAt]).toMatch(/^\[Exit\] exiting with code 0 after \d+s with 0 request\(s\) open, rss \d+ MB, heap \d+ MB$/);
    expect(out.indexOf("[Exit]")).toBeGreaterThan(out.indexOf("db-closed"));
    expect(lines[exitAt + 1]).toBe("  process.exit() called from:");
    expect(lines[exitAt + 2]).toMatch(/[/\\]server-drain\.js:/);
  }, 20_000);

  it("drains on SIGINT (Ctrl-C) too: the app's SIGINT listener runs only after the stream ends", async () => {
    const run = runEntry({ SHUTDOWN_DRAIN_TIMEOUT_MS: "20000" });
    const port = await run.port;

    const result = await streamThenSignal(port, run.child, "SIGINT");
    const { code } = await run.exited;

    expect(result).toEqual({ text: "data: first\n\ndata: last\n\n", complete: true });
    expect(code).toBe(0);
    const out = run.output();
    expect(out).toContain("[Shutdown] SIGINT: draining 1 in-flight request(s)");
    expect(out.indexOf("db-closed-sigint")).toBeGreaterThan(out.indexOf("drained in"));
  }, 20_000);

  it("survives SIGTERM until drained when the app registers no signal listeners of its own", async () => {
    const run = runEntry({ SHUTDOWN_DRAIN_TIMEOUT_MS: "20000" }, bareDir);
    const port = await run.port;

    const result = await streamThenSignal(port, run.child);
    const { code, signal } = await run.exited;

    expect(result).toEqual({ text: "data: first\n\ndata: last\n\n", complete: true });
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(run.output()).toMatch(/\[Shutdown\] drained in \d+s, exiting/);
  }, 20_000);

  it("cuts the stream when SHUTDOWN_DRAIN_TIMEOUT_MS=0 (the old behaviour)", async () => {
    const run = runEntry({ SHUTDOWN_DRAIN_TIMEOUT_MS: "0" });
    const port = await run.port;

    const result = await streamThenSignal(port, run.child);
    await run.exited;

    expect(result.text).toBe("data: first\n\n");
    expect(result.complete).toBe(false);
    expect(run.output()).not.toContain("[Shutdown]");
    expect(run.output()).toContain("SIG undefined");
    // With no drain, the app listener's own process.exit(0) ends the process,
    // and the [Exit] line names that listener in server.js.
    expect(run.output()).toMatch(/\[Exit\] exiting with code 0 [^\n]*\n {2}process\.exit\(\) called from:\n[^\n]*[/\\]server\.js:/);
  }, 20_000);

  it("names an uncaught exception as what ended the process", async () => {
    const run = runEntry({ SHUTDOWN_DRAIN_TIMEOUT_MS: "20000" }, crashDir);
    await run.port;
    const { code } = await run.exited;

    expect(code).toBe(1);
    expect(run.output()).toMatch(/\[Exit\] exiting with code 1 [^\n]*\n {2}an uncaught exception ended the process/);
  }, 20_000);
});
