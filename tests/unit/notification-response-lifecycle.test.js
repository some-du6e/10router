import { describe, expect, it, vi } from "vitest";
import { notificationFetch } from "../../src/lib/notifications/http.js";

describe("notification response lifecycle", () => {
  it.each([200, 302])("cancels an unread HTTP %i body before closing the pinned dispatcher", async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status });
    const close = vi.fn(async () => { expect(cancel).toHaveBeenCalledTimes(1); });
    const deps = {
      fetch: vi.fn().mockResolvedValue(response),
      assertDestination: vi.fn().mockResolvedValue([{ address: "203.0.113.10", family: 4 }]),
      createDispatcher: () => ({ close }),
    };
    if (status === 200) {
      await expect(notificationFetch("https://example.test/hook", {}, deps)).resolves.toBe(response);
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
    const response = {
      ok: false, status: 503,
      body: {
        cancel,
        getReader: () => ({ read: vi.fn().mockRejectedValue(new Error("connection closed")), releaseLock }),
      },
    };
    const close = vi.fn().mockResolvedValue(undefined);
    await expect(notificationFetch("https://example.test/hook", {}, {
      fetch: vi.fn().mockResolvedValue(response),
      assertDestination: vi.fn().mockResolvedValue([{ address: "203.0.113.10", family: 4 }]),
      createDispatcher: () => ({ close }),
    })).rejects.toThrow("Notification request failed (503)");
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });
});
