import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the real custom-server.js entry, with a stand-in for Next's standalone
// server.js beside it, and sends it SIGTERM mid-stream. The stand-in registers
// a SIGTERM listener that exits at once, the way the database adapters do.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const dir = mkdtempSync(join(tmpdir(), "10router-drain-entry-"));
copyFileSync(join(repoRoot, "custom-server.js"), join(dir, "custom-server.js"));
copyFileSync(join(repoRoot, "server-drain.js"), join(dir, "server-drain.js"));
writeFileSync(
  join(dir, "server.js"),
  `const http = require("http");
process.on("SIGTERM", () => { console.log("app-listener"); process.exit(0); });
const server = http.createServer((req, res) => {
  if (req.url === "/slow") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\\n\\n");
    setTimeout(() => res.end("data: last\\n\\n"), 1500);
    return;
  }
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`
);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runEntry(env) {
  const child = spawn(process.execPath, ["custom-server.js"], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

// GET /slow; sends SIGTERM to `child` as soon as the first event arrives.
function streamThenSignal(port, child) {
  return new Promise((res) => {
    let text = "";
    http.get({ host: "127.0.0.1", port, path: "/slow", agent: false }, (response) => {
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
    const run = runEntry({ SHUTDOWN_DRAIN_TIMEOUT_MS: "10000" });
    const port = await run.port;

    const result = await streamThenSignal(port, run.child);
    const { code } = await run.exited;

    expect(result).toEqual({ text: "data: first\n\ndata: last\n\n", complete: true });
    expect(code).toBe(0);
    const out = run.output();
    expect(out).toContain("[Shutdown] SIGTERM: draining 1 in-flight request(s)");
    expect(out).toMatch(/\[Shutdown\] drained in \d+s, exiting/);
    // The app's own listener still runs, after the drain.
    expect(out.indexOf("app-listener")).toBeGreaterThan(out.indexOf("drained in"));
  }, 15_000);

  it("cuts the stream when SHUTDOWN_DRAIN_TIMEOUT_MS=0 (the old behaviour)", async () => {
    const run = runEntry({ SHUTDOWN_DRAIN_TIMEOUT_MS: "0" });
    const port = await run.port;

    const result = await streamThenSignal(port, run.child);
    await run.exited;

    expect(result.text).toBe("data: first\n\n");
    expect(result.complete).toBe(false);
    expect(run.output()).not.toContain("[Shutdown]");
  }, 15_000);
});
