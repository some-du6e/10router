import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { shouldExclude } = require("../../cli/scripts/build-cli.js");
const { hostForBind } = require("../../cli/src/cli/api/client.js");

describe("CLI package build", () => {
  it("never packages env files from the build machine", () => {
    for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development"]) {
      expect(shouldExclude(name), name).toBe(true);
    }
    expect(shouldExclude("server.js")).toBe(false);
  });
});

describe("CLI API client host", () => {
  it("dials an explicit loopback address rather than localhost", () => {
    expect(hostForBind(undefined)).toBe("127.0.0.1");
    expect(hostForBind("0.0.0.0")).toBe("127.0.0.1");
    expect(hostForBind("localhost")).toBe("127.0.0.1");
    expect(hostForBind("::")).toBe("::1");
    expect(hostForBind("192.168.1.5")).toBe("192.168.1.5");
  });
});
