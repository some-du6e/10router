// The /callback page relays an OAuth callback to the dashboard tab and can't
// tell whether anything received it. The dashboard answers with an ack once it
// has used the callback, so the page knows whether to close or to show the URL
// for pasting by hand. Each ack names the callback it answers, so an ack for one
// sign-in never closes the page of another.

export const OAUTH_CALLBACK_ACK_CHANNEL = "oauth_callback_ack";
export const OAUTH_CALLBACK_ACK_TYPE = "oauth_callback_ack";

export type CallbackAck = { type: typeof OAUTH_CALLBACK_ACK_TYPE; key: string; ok: boolean };
type CallbackIdentity = { state?: string | null; fullUrl?: string | null };
type ChannelCtor = new (name: string) => BroadcastChannel;
type MessageTarget = Pick<Window, "addEventListener" | "removeEventListener">;

// 53-bit string hash (cyrb53). It only has to tell callbacks apart; it keeps the
// code itself off the ack channel.
function hashString(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// The callback's OAuth `state`, or a hash of its URL when it has none.
export function callbackAckKey({ state, fullUrl }: CallbackIdentity): string {
  if (state) return `state:${state}`;
  return `url:${hashString(fullUrl || "")}`;
}

export function isCallbackAckFor(message: unknown, key: string): message is CallbackAck {
  if (!message || typeof message !== "object") return false;
  const ack = message as Partial<CallbackAck>;
  return ack.type === OAUTH_CALLBACK_ACK_TYPE && ack.key === key;
}

type SendOptions = {
  ok?: boolean;
  // Answers on the channel the callback came in on (postMessage source).
  reply?: ((ack: CallbackAck) => void) | null;
  Channel?: ChannelCtor | null;
};

export function sendCallbackAck(
  callback: CallbackIdentity,
  { ok = true, reply = null, Channel = globalThis.BroadcastChannel }: SendOptions = {},
): void {
  const ack: CallbackAck = { type: OAUTH_CALLBACK_ACK_TYPE, key: callbackAckKey(callback), ok };
  if (reply) {
    try {
      reply(ack);
    } catch {
      // The popup may already be gone.
    }
  }
  if (!Channel) return;
  try {
    const channel = new Channel(OAUTH_CALLBACK_ACK_CHANNEL);
    channel.postMessage(ack);
    channel.close();
  } catch {
    // No BroadcastChannel: the postMessage reply, if any, is the only answer.
  }
}

type ListenOptions = {
  Channel?: ChannelCtor | null;
  // Window to take postMessage replies on, and the origins accepted there.
  target?: MessageTarget | null;
  origins?: string[];
};

// Passes every ack to onMessage until the returned stop() runs. The caller
// matches the ack's key against its own callback.
export function listenForCallbackAcks(
  onMessage: (ack: CallbackAck) => void,
  { Channel = globalThis.BroadcastChannel, target = null, origins = [] }: ListenOptions = {},
): () => void {
  const deliver = (data: unknown) => {
    if ((data as Partial<CallbackAck> | null)?.type === OAUTH_CALLBACK_ACK_TYPE) onMessage(data as CallbackAck);
  };
  let channel: BroadcastChannel | null = null;
  if (Channel) {
    try {
      channel = new Channel(OAUTH_CALLBACK_ACK_CHANNEL);
      channel.onmessage = (event: MessageEvent) => deliver(event.data);
    } catch {
      channel = null;
    }
  }
  const onWindowMessage = (event: Event) => {
    const { origin, data } = event as MessageEvent;
    if (origins.includes(origin)) deliver(data);
  };
  target?.addEventListener("message", onWindowMessage);
  return () => {
    channel?.close();
    channel = null;
    target?.removeEventListener("message", onWindowMessage);
  };
}
