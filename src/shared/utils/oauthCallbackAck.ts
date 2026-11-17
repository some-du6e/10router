// The /callback page relays an OAuth callback to the dashboard tab and can't
// tell whether anything received it. The dashboard answers on this channel once
// it has taken the callback, so the page only closes itself after that.

export const OAUTH_CALLBACK_ACK_CHANNEL = "oauth_callback_ack";
const ACK_MESSAGE = { type: "oauth_callback_ack" };

type ChannelCtor = new (name: string) => BroadcastChannel;

export function sendCallbackAck(Channel: ChannelCtor | null | undefined = globalThis.BroadcastChannel): void {
  if (!Channel) return;
  try {
    const channel = new Channel(OAUTH_CALLBACK_ACK_CHANNEL);
    channel.postMessage(ACK_MESSAGE);
    channel.close();
  } catch {
    // No BroadcastChannel: the callback page shows its URL to paste instead.
  }
}

// Calls onAck once, then stops listening. Returns a function that stops early.
export function listenForCallbackAck(
  onAck: () => void,
  Channel: ChannelCtor | null | undefined = globalThis.BroadcastChannel,
): () => void {
  if (!Channel) return () => {};
  let channel: BroadcastChannel | null = null;
  const stop = () => {
    channel?.close();
    channel = null;
  };
  try {
    channel = new Channel(OAUTH_CALLBACK_ACK_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== ACK_MESSAGE.type) return;
      stop();
      onAck();
    };
  } catch {
    channel = null;
  }
  return stop;
}
