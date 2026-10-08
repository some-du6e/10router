import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hostCredentials.js", () => ({ loadHostPassword: vi.fn(), saveHostPassword: vi.fn() }));
vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR: "unused" }));
const { quoteWindowsArgument } = await import("../../src/lib/upgrades/retireIdeProxy.js");

describe("Windows cleanup argument serialization", () => {
  it("preserves spaces in a path", () => {
    expect(quoteWindowsArgument("C:\\Program Files\\10router")).toBe('"C:\\Program Files\\10router"');
  });

  it("doubles trailing backslashes before the closing quote", () => {
    expect(quoteWindowsArgument("C:\\data\\")).toBe('"C:\\data\\\\"');
  });

  it("escapes embedded quotes and preceding backslashes", () => {
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
  });
});
