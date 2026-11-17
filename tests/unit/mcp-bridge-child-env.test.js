import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawn = vi.fn(() => Object.assign(new EventEmitter(), {
  stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { writable: true, write() {} },
  killed: false, exitCode: null, kill() {},
}));
vi.mock("child_process", () => ({ spawn }));

const { buildChildEnv } = await import("../../src/lib/mcp/childEnv.ts");
const { getOrSpawn, killAllBridges } = await import("../../src/lib/mcp/stdioSseBridge.js");

const tempDirs = [];
function emptyHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-env-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("MCP stdio bridge child env", () => {
  it("keeps what npx, npm and Node need and drops gateway secrets", () => {
    const home = emptyHome();
    const kept = {
      PATH: "/usr/bin", Path: "C:\\Windows", PATHEXT: ".EXE", HOME: home, USER: "me", LOGNAME: "me",
      SHELL: "/bin/sh", LANG: "C.UTF-8", TERM: "xterm", TZ: "UTC", LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp", TMP: "C:\\Temp", TEMP: "C:\\Temp", XDG_CACHE_HOME: "/home/me/.cache", XDG_CONFIG_HOME: "/home/me/.config",
      SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "cmd.exe", USERPROFILE: "C:\\Users\\me",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\me",
      HTTP_PROXY: "http://proxy:3128", https_proxy: "http://proxy:3128", no_proxy: "localhost", ALL_PROXY: "socks5://proxy:1080",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", NODE_USE_SYSTEM_CA: "1", SSL_CERT_FILE: "/etc/ssl/cert.pem", SSL_CERT_DIR: "/etc/ssl/certs",
      NPM_TOKEN: "npm-token", NODE_AUTH_TOKEN: "node-auth-token",
      npm_config_registry: "https://registry.example", npm_config__authToken: "npm-token",
      "npm_config_//registry.example/:_authToken": "scoped-token", NPM_CONFIG_CAFILE: "/etc/corp-ca.pem",
    };
    const env = buildChildEnv({
      ...kept,
      JWT_SECRET: "jwt", API_KEY_SECRET: "k", INITIAL_PASSWORD: "pw", MACHINE_ID_SALT: "salt",
      NINEROUTER_PEER_TOKEN: "peer", DATA_DIR: "/data", OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "sk-ant",
      NODE_OPTIONS: "--require /tmp/hook.js", npm_config_node_options: "--require /tmp/hook.js",
    }, home);

    expect(env).toEqual(kept);
  });

  it("keeps variables an .npmrc references, but never the gateway's secrets", () => {
    const home = emptyHome();
    const project = emptyHome();
    fs.writeFileSync(path.join(home, ".npmrc"), "//npm.corp.example/:_authToken=${CORP_NPM_TOKEN}\n");
    fs.writeFileSync(path.join(project, ".npmrc"), "@corp:registry=${CORP_REGISTRY}\n//x/:_password=${JWT_SECRET}\n");

    const env = buildChildEnv({ HOME: home, CORP_NPM_TOKEN: "t", CORP_REGISTRY: "https://npm.corp.example", JWT_SECRET: "jwt", UNRELATED: "x" }, project);

    expect(env).toEqual({ HOME: home, CORP_NPM_TOKEN: "t", CORP_REGISTRY: "https://npm.corp.example" });
  });

  it("passes NODE_OPTIONS only when it just selects the system CA store", () => {
    const home = emptyHome();
    expect(buildChildEnv({ NODE_OPTIONS: "--use-system-ca" }, home)).toEqual({ NODE_OPTIONS: "--use-system-ca" });
    expect(buildChildEnv({ NODE_OPTIONS: " --use-openssl-ca  --use-system-ca " }, home).NODE_OPTIONS).toBeDefined();
    expect(buildChildEnv({ NODE_OPTIONS: "--use-system-ca --require ./x.js" }, home)).toEqual({});
    expect(buildChildEnv({ NODE_OPTIONS: "" }, home)).toEqual({});
  });

  it("spawns the Browser MCP child with that env, not the server's", () => {
    vi.stubEnv("JWT_SECRET", "planted-secret");
    vi.stubEnv("OPENAI_API_KEY", "sk-planted");
    try {
      getOrSpawn("browsermcp");
      expect(spawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawn.mock.calls[0];
      expect(command).toBe("npx");
      expect(args).toContain("-y");
      expect(options.env).not.toHaveProperty("JWT_SECRET");
      expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(options.env.PATH).toBe(process.env.PATH);
    } finally {
      killAllBridges();
    }
  });
});
