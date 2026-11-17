import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_ACK_TIMEOUT_MS,
  CALLBACK_CLOSE_DELAY_MS,
  CALLBACK_DONE_DELAY_MS,
  runOAuthCallback,
} from "../../src/shared/utils/oauthCallbackFlow.js";
import { callbackAckKey, OAUTH_CALLBACK_ACK_TYPE } from "../../src/shared/utils/oauthCallbackAck.js";

const ORIGIN = "http://localhost:20128";

// A fake /callback tab: its address bar, what it shows, and the ack listener.
function openCallback(query) {
  const href = `${ORIGIN}/callback${query}`;
  const tab = {
    href,
    address: href,
    status: "processing",
    manualUrl: "",
    closed: 0,
    relayed: [],
    listener: null,
    listens: 0,
  };
  const stop = runOAuthCallback({
    params: new URL(href).searchParams,
    href,
    listen: (onMessage) => {
      tab.listens++;
      tab.listener = onMessage;
      return () => {
        tab.listener = null;
      };
    },
    relay: (data) => tab.relayed.push({ data, addressAtRelay: tab.address }),
    replaceState: () => {
      tab.address = `${ORIGIN}${new URL(tab.address).pathname}`;
    },
    close: () => {
      tab.closed++;
    },
    setStatus: (status) => {
      tab.status = status;
    },
    setManualUrl: (url) => {
      tab.manualUrl = url;
    },
  });
  tab.stop = stop;
  tab.ack = (identity, ok = true) => tab.listener?.({ type: OAUTH_CALLBACK_ACK_TYPE, key: callbackAckKey(identity), ok });
  return tab;
}

let tabs = [];
const open = (query) => {
  const tab = openCallback(query);
  tabs.push(tab);
  return tab;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const tab of tabs) tab.stop();
  tabs = [];
  vi.useRealTimers();
});

describe("/callback page", () => {
  it("strips the code from the address bar before relaying it, and relays the captured URL", () => {
    const tab = open("?code=abc123&state=s1");
    expect(tab.address).toBe(`${ORIGIN}/callback`);
    expect(tab.relayed).toHaveLength(1);
    expect(tab.relayed[0].addressAtRelay).toBe(`${ORIGIN}/callback`);
    expect(tab.relayed[0].data).toMatchObject({ code: "abc123", state: "s1", fullUrl: tab.href });
  });

  it("closes once the dashboard acks this callback", () => {
    const tab = open("?code=abc123&state=s1");
    tab.ack({ state: "s1" });
    expect(tab.status).toBe("success");
    expect(tab.listener).toBeNull();
    vi.advanceTimersByTime(CALLBACK_CLOSE_DELAY_MS);
    expect(tab.closed).toBe(1);
    // The browser kept the tab open (it didn't open it): say it's done.
    vi.advanceTimersByTime(CALLBACK_DONE_DELAY_MS);
    expect(tab.status).toBe("done");
    // The ack timer was cancelled, so the page never flips to manual.
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS);
    expect(tab.status).toBe("done");
  });

  it("shows the captured URL when no ack comes, with the address bar already stripped", () => {
    const tab = open("?code=abc123&state=s1");
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS - 1);
    expect(tab.status).toBe("processing");
    vi.advanceTimersByTime(1);
    expect(tab.status).toBe("manual");
    expect(tab.manualUrl).toBe(tab.href);
    expect(tab.address).toBe(`${ORIGIN}/callback`);
    expect(tab.closed).toBe(0);
    // Still listening for a late ack.
    expect(tab.listener).not.toBeNull();
  });

  it("switches to done when the ack arrives after the timeout", () => {
    const tab = open("?code=abc123&state=s1");
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS + 10_000);
    expect(tab.status).toBe("manual");
    tab.ack({ state: "s1" });
    vi.advanceTimersByTime(CALLBACK_CLOSE_DELAY_MS + CALLBACK_DONE_DELAY_MS);
    expect(tab.closed).toBe(1);
    expect(tab.status).toBe("done");
  });

  it("ignores an ack for another sign-in", () => {
    const tab = open("?code=abc123&state=s1");
    tab.ack({ state: "s2" });
    tab.listener?.({ type: "something-else", key: callbackAckKey({ state: "s1" }), ok: true });
    expect(tab.status).toBe("processing");
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS + CALLBACK_CLOSE_DELAY_MS);
    expect(tab.status).toBe("manual");
    expect(tab.closed).toBe(0);
    expect(tab.listener).not.toBeNull();
  });

  it("matches a callback without state by its URL", () => {
    const tab = open("?token=tok123");
    tab.ack({ fullUrl: `${ORIGIN}/callback?token=other` });
    expect(tab.status).toBe("processing");
    tab.ack({ fullUrl: tab.href });
    expect(tab.status).toBe("success");
  });

  it("says the sign-in failed when the dashboard acks an error callback", () => {
    const tab = open("?error=access_denied&state=s1");
    tab.ack({ state: "s1" }, false);
    expect(tab.status).toBe("failed");
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS + CALLBACK_CLOSE_DELAY_MS);
    expect(tab.status).toBe("failed");
    expect(tab.closed).toBe(0);
  });

  it("shows the URL right away, without listening or relaying, when there is no code", () => {
    const tab = open("?foo=bar");
    expect(tab.status).toBe("manual");
    expect(tab.manualUrl).toBe(tab.href);
    expect(tab.listens).toBe(0);
    expect(tab.relayed).toHaveLength(0);
  });
});
