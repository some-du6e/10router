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
const dir = mkdtempSync(join(tmpdir(), "10router-drain-entry-"));
copyFileSync(join(repoRoot, "custom-server.js"), join(dir, "custom-server.js"));
copyFileSync(join(repoRoot, "server-drain.js"), join(dir, "server-drain.js"));
writeFileSync(
  join(dir, "server.js"),
  `const http = require("http");
process.on("SIGTERM", async () => {
  await new Promise((r) => setTimeout(r, 100));
  console.log("async-flush-done");
});
process.on("SIGTERM", () => { console.log("db-closed"); process.exit(0); });
const server = http.createServer((req, res) => {
  if (req.url === "/v1/slow") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\\n\\n");
    setTimeout(() => res.end("data: last\\n\\n"), 3000);
    return;
  }
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port + " SIG " + process.env.NEXT_MANUAL_SIG_HANDLE));
`
);

const children = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runEntry(env) {
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

// GET /v1/slow; sends SIGTERM to `child` as soon as the first event arrives.
function streamThenSignal(port, child) {
  return new Promise((res) => {
    let text = "";
    http.get({ host: "127.0.0.1", port, path: "/v1/slow", agent: false }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (!text) child.kill("SIGTERM");
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
  }, 20_000);
});
