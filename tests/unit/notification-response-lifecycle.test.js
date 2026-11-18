import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationFetch } from "../../src/lib/notifications/http.js";

const ADDRESS = [{ address: "203.0.113.10", family: 4 }];

function depsFor(fetchResult, close = vi.fn().mockResolvedValue(undefined)) {
  return {
    close,
    deps: {
      fetch: typeof fetchResult === "function" ? fetchResult : vi.fn().mockResolvedValue(fetchResult),
      assertDestination: vi.fn().mockResolvedValue(ADDRESS),
      createDispatcher: () => ({ close }),
    },
  };
}

let server;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

describe("notification response lifecycle", () => {
  it.each([200, 302])("cancels an unread HTTP %i body before closing the pinned dispatcher", async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status });
    const { deps, close } = depsFor(response);
    if (status === 200) {
      await expect(notificationFetch("https://example.test/hook", {}, deps)).resolves.toBe(200);
    } else {
      await expect(notificationFetch("https://example.test/hook", {}, deps)).rejects.toThrow("redirect");
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it("releases a failed diagnostic body read before dispatcher shutdown", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const { deps, close } = depsFor({
      ok: false, status: 503,
      body: {
        cancel,
        getReader: () => ({ read: vi.fn().mockRejectedValue(new Error("connection closed")), releaseLock }),
      },
    });
    await expect(notificationFetch("https://example.test/hook", {}, deps)).rejects.toThrow("Notification request failed (503)");
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it("still closes the dispatcher and returns the status when body cancel throws", async () => {
    const cancel = vi.fn(() => { throw new TypeError("locked"); });
    const { deps, close } = depsFor({ ok: true, status: 204, body: { cancel } });
    await expect(notificationFetch("https://example.test/hook", {}, deps)).resolves.toBe(204);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the HTTP error when body cancel rejects", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("socket gone"));
    const { deps, close } = depsFor({ ok: false, status: 503, body: { cancel } });
    await expect(notificationFetch("https://example.test/hook", {}, deps)).rejects.toThrow("Notification request failed (503)");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the fetch error and still closes the dispatcher when fetch rejects", async () => {
    const error = new Error("connect ECONNREFUSED");
    const { deps, close } = depsFor(vi.fn().mockRejectedValue(error));
    await expect(notificationFetch("https://example.test/hook", {}, deps)).rejects.toBe(error);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns against a real pinned dispatcher when the server never finishes the body", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("partial");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    await expect(notificationFetch(`http://127.0.0.1:${port}/hook`, {}, {
      assertDestination: vi.fn().mockResolvedValue([{ address: "127.0.0.1", family: 4 }]),
    })).resolves.toBe(200);
  });
});
