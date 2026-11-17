import { afterEach, describe, expect, it, vi } from "vitest";
import { listenForCallbackAck, OAUTH_CALLBACK_ACK_CHANNEL, sendCallbackAck } from "../../src/shared/utils/oauthCallbackAck.js";

const waitFor = async (check) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

let stops = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

describe("OAuth callback acknowledgement", () => {
  it("tells the /callback page that the dashboard took its callback", async () => {
    const onAck = vi.fn();
    stops.push(listenForCallbackAck(onAck));
    sendCallbackAck();
    await waitFor(() => onAck.mock.calls.length > 0);
    expect(onAck).toHaveBeenCalledOnce();
  });

  it("fires once, then stops listening", async () => {
    const onAck = vi.fn();
    stops.push(listenForCallbackAck(onAck));
    sendCallbackAck();
    await waitFor(() => onAck.mock.calls.length > 0);
    sendCallbackAck();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onAck).toHaveBeenCalledOnce();
  });

  it("ignores other messages on the channel and an ack sent after it stopped", async () => {
    const onAck = vi.fn();
    const stop = listenForCallbackAck(onAck);
    const other = new BroadcastChannel(OAUTH_CALLBACK_ACK_CHANNEL);
    other.postMessage({ type: "something-else" });
    other.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    sendCallbackAck();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onAck).not.toHaveBeenCalled();
  });

  it("does nothing without BroadcastChannel", () => {
    expect(() => sendCallbackAck(null)).not.toThrow();
    const stop = listenForCallbackAck(() => {}, null);
    expect(() => stop()).not.toThrow();
  });
});
