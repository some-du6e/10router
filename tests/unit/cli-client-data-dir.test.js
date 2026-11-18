import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire, Module } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// End to end: the token the CLI's API client sends must be one the server accepts.
const require = createRequire(import.meta.url);
const CLIENT = require.resolve("../../cli/src/cli/api/client.js");
const HELPER = require.resolve("../../cli/hooks/dataDir.js");
const MACHINE_ID = createRequire(CLIENT).resolve("node-machine-id");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-token-"));
  vi.stubEnv("HOME", path.join(tmp, "home"));
  vi.stubEnv("DATA_DIR", "");
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
  vi.resetModules();
  delete require.cache[CLIENT];
  delete require.cache[HELPER];
  delete require.cache[MACHINE_ID];
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Make node-machine-id fail for the client, as it does on some hosts.
function breakMachineIdSync() {
  const stub = new Module(MACHINE_ID);
  stub.filename = MACHINE_ID;
  stub.loaded = true;
  stub.exports = { machineIdSync: () => { throw new Error("no machine id"); } };
  require.cache[MACHINE_ID] = stub;
}

// Load the server's token check and a fresh client, both reading the current
// env and platform at load time (that is when they fix their file paths).
async function load(platform = platformDescriptor.value) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  try {
    vi.resetModules();
    const server = await import("../../src/lib/auth/cliToken.js");
    // Like a running server: it writes machine-id and auth/cli-secret first.
    await server.getCliToken();
    delete require.cache[CLIENT];
    delete require.cache[HELPER];
    const client = require(CLIENT);
    return { server, client };
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

async function tokenSentBy(client) {
  let seen;
  const server = http.createServer((req, res) => {
    seen = req.headers["x-9r-cli-token"];
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    client.configure({ host: "127.0.0.1", port: server.address().port, protocol: "http:" });
    const result = await client.getSettings();
    expect(result.success).toBe(true);
    return seen;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("CLI API client token", () => {
  it("is accepted by the server with the default data directory", async () => {
    const { server, client } = await load();
    const token = await tokenSentBy(client);
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    expect(await server.isValidCliToken(token)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "home", ".9router", "auth", "cli-secret"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "home", ".10router"))).toBe(false);
  });

  it("is accepted by the server on Windows with APPDATA", async () => {
    vi.stubEnv("APPDATA", path.join(tmp, "appdata"));
    const { server, client } = await load("win32");
    const token = await tokenSentBy(client);
    expect(await server.isValidCliToken(token)).toBe(true);
    expect(fs.existsSync(path.join(tmp, "appdata", "9router", "auth", "cli-secret"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "appdata", "10router"))).toBe(false);
  });

  it("is accepted by the server with DATA_DIR", async () => {
    const dataDir = path.join(tmp, "data");
    vi.stubEnv("DATA_DIR", dataDir);
    const { server, client } = await load();
    const token = await tokenSentBy(client);
    expect(await server.isValidCliToken(token)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "auth", "cli-secret"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "home", ".9router"))).toBe(false);
  });

  it("is not stuck empty when the client starts before the server has written its files", async () => {
    breakMachineIdSync();
    delete require.cache[CLIENT];
    delete require.cache[HELPER];
    const client = require(CLIENT);
    expect(await tokenSentBy(client)).toBe("");

    vi.resetModules();
    const server = await import("../../src/lib/auth/cliToken.js");
    await server.getCliToken();
    const token = await tokenSentBy(client);
    expect(token).toMatch(/^[0-9a-f]{16}$/);
    expect(await server.isValidCliToken(token)).toBe(true);
  });
});
