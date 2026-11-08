import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/lib/mcp/childEnv.ts";


describe("MCP stdio bridge child env", () => {
  it("keeps what npx needs and drops gateway secrets", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      Path: "C:\\Windows",
      LC_ALL: "C.UTF-8",
      npm_config_registry: "https://registry.example",
      HTTPS_PROXY: "http://proxy:3128",
      JWT_SECRET: "jwt",
      API_KEY_SECRET: "k",
      INITIAL_PASSWORD: "pw",
      NINEROUTER_PEER_TOKEN: "peer",
      DATA_DIR: "/data",
      OPENAI_API_KEY: "sk",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/me",
      Path: "C:\\Windows",
      LC_ALL: "C.UTF-8",
      npm_config_registry: "https://registry.example",
      HTTPS_PROXY: "http://proxy:3128",
    });
  });
});
