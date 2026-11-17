// What the /callback page does with an OAuth redirect, without touching window,
// so tests can drive it with fake timers. The page passes in the browser pieces.

import { callbackAckKey, isCallbackAckFor } from "./oauthCallbackAck.js";

// How long to wait for the dashboard to say it took the callback before showing
// the URL to paste by hand.
export const CALLBACK_ACK_TIMEOUT_MS = 4000;
// How long to wait, after "received", for the exchange to end. Some providers
// make several upstream calls, and a slow proxy adds to each.
export const CALLBACK_EXCHANGE_TIMEOUT_MS = 60_000;
export const CALLBACK_CLOSE_DELAY_MS = 1500;
export const CALLBACK_DONE_DELAY_MS = 500;

// manual: nothing took the callback. slow: the dashboard took it but hasn't
// finished. Both show the captured URL. A later ack still moves the page on.
export type CallbackStatus = "processing" | "connecting" | "success" | "done" | "manual" | "slow" | "failed";

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

  // Takes the code out of this tab's address bar and its back/forward entry
  // before anything else runs, so scripts that read location later don't see
  // it. It can't remove the URL from the browser's global history, autocomplete
  // or sync, which recorded it on load. The manual screens show the copy kept
  // here.
  replaceState();
  setManualUrl(data.fullUrl);

  if (!(data.code || data.token || data.error)) {
    setStatus("manual");
    return () => {};
  }

  const key = callbackAckKey(data);
  const pending: unknown[] = [];
  const later = (fn: () => void, ms: number) => {
    const id = timers.setTimeout(fn, ms);
    pending.push(id);
    return id;
  };
  const cancel = (id: unknown) => {
    if (id !== null) timers.clearTimeout(id);
  };
  let received = false;
  let finished = false;
  let ackTimer: unknown = null;
  let exchangeTimer: unknown = null;
  let stopListening: () => void = () => {};

  const onMessage = (message: unknown) => {
    if (finished || !isCallbackAckFor(message, key)) return;
    if (message.status === "received") {
      if (received) return;
      received = true;
      cancel(ackTimer);
      setStatus("connecting");
      exchangeTimer = later(() => setStatus("slow"), CALLBACK_EXCHANGE_TIMEOUT_MS);
      return;
    }
    finished = true;
    cancel(ackTimer);
    cancel(exchangeTimer);
    stopListening();
    if (message.status === "failed") {
      setStatus("failed");
      return;
    }
    setStatus("success");
    later(() => {
      close();
      // Still here when the browser refuses to close a tab it didn't open.
      later(() => setStatus("done"), CALLBACK_DONE_DELAY_MS);
    }, CALLBACK_CLOSE_DELAY_MS);
  };

  stopListening = listen(onMessage);
  ackTimer = later(() => setStatus("manual"), CALLBACK_ACK_TIMEOUT_MS);

  relay(data);

  return () => {
    stopListening();
    for (const id of pending) timers.clearTimeout(id);
  };
}
