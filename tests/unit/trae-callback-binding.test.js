import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeTokens: vi.fn(async () => ({ accessToken: "at", refreshToken: "rt" })),
  createProviderConnection: vi.fn(async () => ({ id: "conn-1", email: "owner@example.com" })),
}));
vi.mock("../../src/lib/oauth/providers.js", () => ({ exchangeTokens: mocks.exchangeTokens }));
vi.mock("@/models", () => ({ createProviderConnection: mocks.createProviderConnection }));

const { startTraeProxy, stopTraeProxy, registerTraeSession, getTraeSessionStatus, clearTraeSession } =
  await import("../../src/lib/oauth/utils/server.js");

afterEach(() => {
  stopTraeProxy();
  clearTraeSession();
  vi.clearAllMocks();
});

describe("Trae loopback callback binding", () => {
  it("issues a callback URL with an unguessable path per proxy", async () => {
    const first = await startTraeProxy();
    stopTraeProxy();
    const second = await startTraeProxy();
    expect(new URL(first.callbackUrl).pathname).toMatch(/^\/callback\/[\w-]{32}$/);
    expect(new URL(first.callbackUrl).pathname).not.toBe(new URL(second.callbackUrl).pathname);
  });

  it.each(["/callback", "/auth/callback", "/callback/guess"])(
    "ignores a stateless callback on %s without saving a connection or aborting the login",
    async (path) => {
      const { port, callbackUrl } = await startTraeProxy();
      registerTraeSession({ state: "s1" });
      const res = await fetch(`http://127.0.0.1:${port}${path}?refreshToken=attacker&loginHost=x`);
      expect(res.status).toBe(404);
      expect(mocks.exchangeTokens).not.toHaveBeenCalled();
      expect(getTraeSessionStatus("s1").status).toBe("pending");
      expect((await startTraeProxy()).callbackUrl).toBe(callbackUrl);
    },
  );

  it("completes the login on the issued callback URL", async () => {
    const { callbackUrl } = await startTraeProxy();
    registerTraeSession({ state: "s1" });
    const res = await fetch(`${callbackUrl}?refreshToken=owner&loginHost=x`);
    expect(res.status).toBe(200);
    expect(mocks.exchangeTokens).toHaveBeenCalledWith("trae", expect.stringContaining("refreshToken=owner"));
    expect(getTraeSessionStatus("s1")).toEqual(expect.objectContaining({ status: "done", connectionId: "conn-1" }));
  });
});
