import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cliRoot = path.resolve(import.meta.dirname, "../../cli");
const source = fs.readFileSync(process.env.CLI_AUTOSTART_SOURCE || path.join(cliRoot, "src/cli/tray/autostart.js"), "utf8");

function enable(platform, options) {
  const writes = [];
  const commonJsModule = { exports: {} };
  vm.runInNewContext(source, {
    require: (name) => {
      if (name === "fs") return { existsSync: () => true, writeFileSync: (file, contents) => writes.push({ file, contents }) };
      if (name === "os") return { homedir: () => "/user" };
      if (name === "child_process") return { execSync: () => "" };
      return require(name.startsWith(".") ? path.join(cliRoot, "src/cli/tray", name) : name);
    },
    module: commonJsModule, __dirname: path.join(cliRoot, "src/cli/tray"),
    process: { platform, execPath: "/node runtime/node", argv: [], env: { DISPLAY: ":0", APPDATA: "/appdata" } },
  });
  expect(commonJsModule.exports.enableAutoStart("/router folder/cli.js", options)).toBe(true);
  return writes[0].contents;
}

describe("autostart bind configuration", () => {
  it.each(["darwin", "win32", "linux"])("preserves custom bind and port on %s", (platform) => {
    const contents = enable(platform, { host: "127.0.0.1", port: 20200 });
    expect(contents).toContain("--host");
    expect(contents).toContain("127.0.0.1");
    expect(contents).toContain("--port");
    expect(contents).toContain("20200");
  });
  it("quotes paths containing spaces in Linux desktop entries", () => {
    expect(enable("linux")).toContain('Exec="/node runtime/node" "/router folder/cli.js"');
  });
});
