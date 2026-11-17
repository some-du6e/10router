import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_ACK_TIMEOUT_MS,
  CALLBACK_CLOSE_DELAY_MS,
  CALLBACK_DONE_DELAY_MS,
  CALLBACK_EXCHANGE_TIMEOUT_MS,
  runOAuthCallback,
  takeOAuthCallback,
} from "../../src/shared/utils/oauthCallbackFlow.js";
import { callbackAckKey, OAUTH_CALLBACK_ACK_TYPE, sendCallbackAck } from "../../src/shared/utils/oauthCallbackAck.js";

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
  tab.ack = (identity, status = "saved") =>
    tab.listener?.({ type: OAUTH_CALLBACK_ACK_TYPE, key: callbackAckKey(identity), status });
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

  it("closes once the dashboard saves the connection", () => {
    const tab = open("?code=abc123&state=s1");
    tab.ack({ state: "s1" });
    expect(tab.status).toBe("success");
    expect(tab.listener).toBeNull();
    vi.advanceTimersByTime(CALLBACK_CLOSE_DELAY_MS);
    expect(tab.closed).toBe(1);
    // The browser kept the tab open (it didn't open it): say it's done.
    vi.advanceTimersByTime(CALLBACK_DONE_DELAY_MS);
    expect(tab.status).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
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

  it("ignores an ack for another sign-in, and malformed acks", () => {
    const tab = open("?code=abc123&state=s1");
    tab.ack({ state: "s2" });
    tab.ack({ state: "s1" }, "bogus");
    tab.listener?.({ type: "something-else", key: callbackAckKey({ state: "s1" }), status: "saved" });
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

  it("says the sign-in failed when the dashboard reports a provider error", () => {
    const tab = open("?error=access_denied&state=s1");
    tab.ack({ state: "s1" }, "failed");
    expect(tab.status).toBe("failed");
    expect(tab.listener).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
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

describe("/callback page during a slow exchange", () => {
  it("waits past the ack timeout once received, then closes when saved", () => {
    const tab = open("?code=abc123&state=s1");
    tab.ack({ state: "s1" }, "received");
    expect(tab.status).toBe("connecting");
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS * 5);
    expect(tab.status).toBe("connecting");
    tab.ack({ state: "s1" }, "received");
    expect(tab.status).toBe("connecting");
    tab.ack({ state: "s1" }, "saved");
    expect(tab.status).toBe("success");
    vi.advanceTimersByTime(CALLBACK_CLOSE_DELAY_MS + CALLBACK_DONE_DELAY_MS);
    expect(tab.closed).toBe(1);
    expect(tab.status).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves from the manual screen to connecting when received comes late, then closes when saved", () => {
    const tab = open("?code=abc123&state=s1");
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS);
    expect(tab.status).toBe("manual");
    tab.ack({ state: "s1" }, "received");
    expect(tab.status).toBe("connecting");
    tab.ack({ state: "s1" }, "saved");
    expect(tab.status).toBe("success");
    vi.advanceTimersByTime(CALLBACK_CLOSE_DELAY_MS + CALLBACK_DONE_DELAY_MS);
    expect(tab.closed).toBe(1);
    expect(tab.status).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says the sign-in failed when the exchange fails", () => {
    const tab = open("?code=abc123&state=s1");
    tab.ack({ state: "s1" }, "received");
    vi.advanceTimersByTime(CALLBACK_ACK_TIMEOUT_MS * 2);
    tab.ack({ state: "s1" }, "failed");
    expect(tab.status).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
    // Nothing later reopens it.
    tab.ack({ state: "s1" }, "saved");
    expect(tab.status).toBe("failed");
    expect(tab.closed).toBe(0);
  });

  it("says it's still connecting once the exchange runs past its limit", () => {
    const tab = open("?code=abc123&state=s1");
    tab.ack({ state: "s1" }, "received");
    vi.advanceTimersByTime(CALLBACK_EXCHANGE_TIMEOUT_MS - 1);
    expect(tab.status).toBe("connecting");
    vi.advanceTimersByTime(1);
    expect(tab.status).toBe("slow");
    expect(vi.getTimerCount()).toBe(0);
    // A final ack after that still lands.
    tab.ack({ state: "s1" }, "saved");
    expect(tab.status).toBe("success");
  });
});

// A connect dialog: its pending login, and what it acked, exchanged and showed.
function connectDialog({ provider = "gemini-cli", state = "s1", saved = true, redirectUri = `${ORIGIN}/callback` } = {}) {
  const d = {
    authData: { state, redirectUri },
    processed: false,
    acks: [],
    errors: [],
    notices: 0,
    exchanges: [],
    acksAtExchange: null,
  };
  d.take = (data, ctx = {}, reply = null) =>
    takeOAuthCallback(
      data,
      { provider, authData: d.authData, processed: d.processed, via: "broadcast", ...ctx },
      {
        markProcessed: () => {
          d.processed = true;
        },
        notice: () => {
          d.notices++;
        },
        exchange: async (code, cbState) => {
          d.acksAtExchange = [...d.acks];
          d.exchanges.push({ code, state: cbState });
          return saved;
        },
        ack: (status) => {
          d.acks.push(status);
          if (reply) sendCallbackAck(data, { status, reply, Channel: null });
        },
        onError: (message) => d.errors.push(message),
      },
    );
  return d;
}

describe("connect dialog taking a relayed callback", () => {
  it("acks received before the exchange and saved after it succeeds", async () => {
    const d = connectDialog();
    expect(await d.take({ code: "abc123", state: "s1" })).toBe("exchanged");
    expect(d.acksAtExchange).toEqual(["received"]);
    expect(d.exchanges).toEqual([{ code: "abc123", state: "s1" }]);
    expect(d.acks).toEqual(["received", "saved"]);
    expect(d.errors).toEqual([]);
  });

  it("acks failed after an exchange that fails", async () => {
    const d = connectDialog({ saved: false });
    await d.take({ code: "abc123", state: "s1" });
    expect(d.acksAtExchange).toEqual(["received"]);
    expect(d.acks).toEqual(["received", "failed"]);
  });

  it("exchanges a token in preference to a code", async () => {
    const d = connectDialog();
    await d.take({ token: "tok123", code: "abc123", state: "s1" });
    expect(d.exchanges).toEqual([{ code: "tok123", state: "s1" }]);
  });

  it("acks a provider error as failed without exchanging", async () => {
    const d = connectDialog();
    await d.take({ error: "access_denied", errorDescription: "User said no", state: "s1" });
    expect(d.acks).toEqual(["failed"]);
    expect(d.exchanges).toEqual([]);
    expect(d.errors).toEqual(["User said no"]);

    const bare = connectDialog();
    await bare.take({ error: "access_denied", state: "s1" });
    expect(bare.errors).toEqual(["access_denied"]);
  });

  it("does nothing for a callback without a code, token or error", async () => {
    const d = connectDialog();
    expect(await d.take({ state: "s1" })).toBe("ignored");
    expect(d.acks).toEqual([]);
    expect(d.exchanges).toEqual([]);
    expect(d.notices).toBe(0);
  });

  it("takes a callback once", async () => {
    const d = connectDialog();
    await d.take({ code: "abc123", state: "s1" });
    await d.take({ code: "abc123", state: "s1" });
    expect(d.exchanges).toHaveLength(1);
    expect(d.acks).toEqual(["received", "saved"]);
  });
});

describe("connect dialog ignoring a callback that isn't its login's", () => {
  const ignored = async (d, data, ctx) => {
    expect(await d.take(data, ctx)).toBe("ignored");
    expect(d.acks).toEqual([]);
    expect(d.exchanges).toEqual([]);
    expect(d.errors).toEqual([]);
  };

  it("sends no ack and runs no exchange for another login's state, even an error", async () => {
    const d = connectDialog({ state: "s1" });
    await ignored(d, { code: "abc123", state: "s2" });
    await ignored(d, { error: "access_denied", state: "s2" });
    await ignored(d, { code: "abc123" });
    expect(d.notices).toBe(3);
  });

  it.each(["trae", "windsurf", "zed"])("never takes a relayed callback for proxy provider %s", async (provider) => {
    await ignored(connectDialog({ provider }), { code: "abc123", state: "s1" });
  });

  it("takes a stateless provider's callback only from its own popup", async () => {
    const popup = { via: "message", fromOwnPopup: true, origin: ORIGIN };
    await ignored(connectDialog({ provider: "cline", state: null }), { code: "cred" });
    await ignored(connectDialog({ provider: "cline", state: null }), { code: "cred" }, { ...popup, fromOwnPopup: false });
    const own = connectDialog({ provider: "cline", state: null });
    await own.take({ code: "cred" }, popup);
    expect(own.acks).toEqual(["received", "saved"]);
  });

  it("lets only the dialog that owns the callback answer when a stale one is also open", async () => {
    const tab = open("?code=abc123&state=s1");
    const relayed = tab.relayed[0].data;
    const toPage = (ack) => tab.listener?.(ack);
    // A closed dialog in another tab still holds an older login, and its
    // exchange would fail.
    const stale = connectDialog({ state: "s-old", saved: false });
    const current = connectDialog({ state: "s1" });
    // The stale one hears the relay first.
    await stale.take(relayed, {}, toPage);
    await current.take(relayed, {}, toPage);
    expect(stale.acks).toEqual([]);
    expect(stale.exchanges).toEqual([]);
    expect(current.exchanges).toEqual([{ code: "abc123", state: "s1" }]);
    expect(current.acks).toEqual(["received", "saved"]);
    expect(tab.status).toBe("success");
    vi.advanceTimersByTime(CALLBACK_CLOSE_DELAY_MS + CALLBACK_DONE_DELAY_MS);
    expect(tab.closed).toBe(1);
    expect(tab.status).toBe("done");
  });
});
