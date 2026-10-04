import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptHostPassword, decryptHostPassword } from "../../src/lib/db/helpers/hostCredentials.js";

const machineId = createRequire(import.meta.url)("node-machine-id");
afterEach(() => vi.restoreAllMocks());

describe("Host credential encryption key", () => {
  it("refuses to encrypt or decrypt when machine identification fails", () => {
    const encrypted = encryptHostPassword("secret");
    vi.spyOn(machineId, "machineIdSync").mockImplementation(() => { throw new Error("Unavailable"); });
    expect(() => encryptHostPassword("secret")).toThrow("Unavailable");
    expect(decryptHostPassword(encrypted)).toBe("");
  });

  it("refuses to use an empty machine identity", () => {
    vi.spyOn(machineId, "machineIdSync").mockReturnValue("");
    expect(() => encryptHostPassword("secret")).toThrow("Machine identity is unavailable");
  });
});
