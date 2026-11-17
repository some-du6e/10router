import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callbackAckKey,
  isCallbackAckFor,
  listenForCallbackAcks,
  OAUTH_CALLBACK_ACK_CHANNEL,
  OAUTH_CALLBACK_ACK_TYPE,
  sendCallbackAck,
} from "../../src/shared/utils/oauthCallbackAck.js";

const ORIGIN = "http://localhost:20128";
const CALLBACK = { state: "s1", fullUrl: `${ORIGIN}/callback?code=abc123&state=s1` };

const waitFor = async (check) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let stops = [];
const listen = (...args) => {
  const stop = listenForCallbackAcks(...args);
  stops.push(stop);
  return stop;
};

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.unstubAllGlobals();
});

describe("OAuth callback ack key", () => {
  it("uses the state, or a hash of the URL that doesn't carry the code", () => {
    expect(callbackAckKey({ state: "s1" })).toBe("state:s1");
    const byUrl = callbackAckKey({ fullUrl: `${ORIGIN}/callback?token=tok123` });
    expect(byUrl).toMatch(/^url:/);
    expect(byUrl).not.toContain("tok123");
    expect(byUrl).toBe(callbackAckKey({ state: "", fullUrl: `${ORIGIN}/callback?token=tok123` }));
    expect(byUrl).not.toBe(callbackAckKey({ fullUrl: `${ORIGIN}/callback?token=tok124` }));
  });
});

describe("OAuth callback ack over BroadcastChannel", () => {
  it("reaches the /callback page with that callback's key", async () => {
    const onMessage = vi.fn();
    listen(onMessage);
    sendCallbackAck(CALLBACK);
    await waitFor(() => onMessage.mock.calls.length > 0);
    expect(onMessage).toHaveBeenCalledOnce();
    const [ack] = onMessage.mock.calls[0];
    expect(isCallbackAckFor(ack, callbackAckKey(CALLBACK))).toBe(true);
    expect(isCallbackAckFor(ack, callbackAckKey({ state: "s2" }))).toBe(false);
    expect(ack.ok).toBe(true);
  });

  it("marks an ack for an error callback as not ok", async () => {
    const onMessage = vi.fn();
    listen(onMessage);
    sendCallbackAck(CALLBACK, { ok: false });
    await waitFor(() => onMessage.mock.calls.length > 0);
    expect(onMessage.mock.calls[0][0].ok).toBe(false);
  });

  it("stops delivering after stop()", async () => {
    const onMessage = vi.fn();
    const stop = listen(onMessage);
    stop();
    sendCallbackAck(CALLBACK);
    await settle();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores other messages on the channel", async () => {
    const onMessage = vi.fn();
    listen(onMessage);
    const other = new BroadcastChannel(OAUTH_CALLBACK_ACK_CHANNEL);
    other.postMessage({ type: "something-else" });
    other.postMessage(null);
    other.close();
    await settle();
    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe("OAuth callback ack over postMessage", () => {
  const message = (data, origin = ORIGIN) => new MessageEvent("message", { data, origin });

  it("replies on the channel the callback came in on", () => {
    const reply = vi.fn();
    sendCallbackAck(CALLBACK, { reply, Channel: null });
    expect(reply).toHaveBeenCalledWith({ type: OAUTH_CALLBACK_ACK_TYPE, key: "state:s1", ok: true });
  });

  it("survives a reply to a window that is gone", () => {
    expect(() => sendCallbackAck(CALLBACK, {
      reply: () => {
        throw new Error("closed");
      },
      Channel: null,
    })).not.toThrow();
  });

  it("takes acks from allowed origins only, until stopped", () => {
    const target = new EventTarget();
    const onMessage = vi.fn();
    const stop = listen(onMessage, { Channel: null, target, origins: [ORIGIN] });
    const ack = { type: OAUTH_CALLBACK_ACK_TYPE, key: "state:s1", ok: true };
    target.dispatchEvent(message(ack, "http://evil.example"));
    target.dispatchEvent(message({ type: "oauth_callback", data: {} }));
    expect(onMessage).not.toHaveBeenCalled();
    target.dispatchEvent(message(ack));
    expect(onMessage).toHaveBeenCalledWith(ack);
    stop();
    target.dispatchEvent(message(ack));
    expect(onMessage).toHaveBeenCalledOnce();
  });
});

describe("without a working BroadcastChannel", () => {
  const ack = { type: OAUTH_CALLBACK_ACK_TYPE, key: "state:s1", ok: true };

  for (const [name, value] of [
    ["undefined", undefined],
    [
      "whose constructor throws",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    ],
  ]) {
    it(`still acks by reply when BroadcastChannel is ${name}`, () => {
      vi.stubGlobal("BroadcastChannel", value);
      const reply = vi.fn();
      expect(() => sendCallbackAck(CALLBACK, { reply })).not.toThrow();
      expect(reply).toHaveBeenCalledWith(ack);
    });

    it(`still listens on the window when BroadcastChannel is ${name}`, () => {
      vi.stubGlobal("BroadcastChannel", value);
      const target = new EventTarget();
      const onMessage = vi.fn();
      let stop;
      expect(() => {
        stop = listen(onMessage, { target, origins: [ORIGIN] });
      }).not.toThrow();
      target.dispatchEvent(new MessageEvent("message", { data: ack, origin: ORIGIN }));
      expect(onMessage).toHaveBeenCalledWith(ack);
      expect(() => stop()).not.toThrow();
    });
  }
});
