// What the /callback page does with an OAuth redirect, without touching window,
// so tests can drive it with fake timers. The page passes in the browser pieces.

import { callbackAckKey, isCallbackAckFor } from "./oauthCallbackAck.js";

// How long to wait for the dashboard to say it used the callback before showing
// the URL to paste by hand. A later ack still switches the page to done.
export const CALLBACK_ACK_TIMEOUT_MS = 4000;
export const CALLBACK_CLOSE_DELAY_MS = 1500;
export const CALLBACK_DONE_DELAY_MS = 500;

export type CallbackStatus = "processing" | "success" | "done" | "manual" | "failed";

export type CallbackData = {
  code: string | null;
  token: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
  fullUrl: string;
};

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export type CallbackFlowInput = {
  params: Pick<URLSearchParams, "get">;
  href: string;
  // Subscribes to ack messages; returns a function that unsubscribes.
  listen: (onMessage: (message: unknown) => void) => () => void;
  relay: (data: CallbackData) => void;
  // Removes the query from the address bar.
  replaceState: () => void;
  close: () => void;
  setStatus: (status: CallbackStatus) => void;
  setManualUrl: (url: string) => void;
  timers?: Timers;
};

// Returns a function that stops listening and cancels pending timers.
export function runOAuthCallback({
  params,
  href,
  listen,
  relay,
  replaceState,
  close,
  setStatus,
  setManualUrl,
  timers = globalThis as unknown as Timers,
}: CallbackFlowInput): () => void {
  const data: CallbackData = {
    code: params.get("code"),
    token: params.get("token"),
    state: params.get("state"),
    error: params.get("error"),
    errorDescription: params.get("error_description"),
    fullUrl: href,
  };

  // The code leaves the address bar (and with it history and any script that
  // reads location) before anything else runs. The manual screen shows the
  // copy kept here.
  replaceState();
  setManualUrl(data.fullUrl);

  if (!(data.code || data.token || data.error)) {
    setStatus("manual");
    return () => {};
  }

  const key = callbackAckKey(data);
  const pending: unknown[] = [];
  let acked = false;
  let ackTimer: unknown = null;
  let stopListening: () => void = () => {};

  const onMessage = (message: unknown) => {
    if (acked || !isCallbackAckFor(message, key)) return;
    acked = true;
    timers.clearTimeout(ackTimer);
    stopListening();
    if (!message.ok) {
      setStatus("failed");
      return;
    }
    setStatus("success");
    pending.push(timers.setTimeout(() => {
      close();
      // Still here when the browser refuses to close a tab it didn't open.
      pending.push(timers.setTimeout(() => setStatus("done"), CALLBACK_DONE_DELAY_MS));
    }, CALLBACK_CLOSE_DELAY_MS));
  };

  stopListening = listen(onMessage);
  ackTimer = timers.setTimeout(() => {
    if (!acked) setStatus("manual");
  }, CALLBACK_ACK_TIMEOUT_MS);

  relay(data);

  return () => {
    stopListening();
    timers.clearTimeout(ackTimer);
    for (const id of pending) timers.clearTimeout(id);
  };
}
