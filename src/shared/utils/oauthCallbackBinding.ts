interface CallbackData {
  code?: string | null;
  token?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}

export type CallbackDecision =
  | { action: "ignore"; notice: boolean }
  | { action: "error"; message: string }
  | { action: "exchange"; code: string; state: string | null };

interface PendingAuth {
  state?: string | null;
  proxyProvider?: string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Their authorize URL carries no state, so their callback can't echo one.
const STATELESS_CALLBACK_PROVIDERS = new Set(["cline", "clinepass"]);

// Their callback goes to a local proxy that exchanges it on the server (Trae
// carries its state as login_trace_id). A callback relayed by /callback is
// never theirs.
const SERVER_EXCHANGE_PROVIDERS = new Set(["trae", "windsurf", "zed"]);

export function isTrustedCallbackOrigin(origin: string, ownOrigin: string): boolean {
  if (origin === ownOrigin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// A relayed callback belongs to the pending login only if it echoes that login's state.
export function isCallbackForPendingAuth(
  data: CallbackData | null | undefined,
  authData: PendingAuth | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (!data || !authData || !provider) return false;
  if (SERVER_EXCHANGE_PROVIDERS.has(provider) || authData.proxyProvider) return false;
  if (STATELESS_CALLBACK_PROVIDERS.has(provider)) return !data.state || data.state === authData.state;
  return typeof authData.state === "string" && authData.state !== "" && data.state === authData.state;
}

// What the connect dialog does with a relayed callback. "ignore" leaves the
// pending login waiting, so the real callback is still taken when it arrives.
export function decideRelayedCallback(
  data: CallbackData | null | undefined,
  authData: PendingAuth | null | undefined,
  provider: string | null | undefined,
): CallbackDecision {
  if (!data || !isCallbackForPendingAuth(data, authData, provider)) {
    return { action: "ignore", notice: !!(data?.code || data?.token || data?.error) };
  }
  if (data.error) return { action: "error", message: data.errorDescription || data.error };
  const code = data.token || data.code;
  if (code) return { action: "exchange", code, state: data.state ?? null };
  return { action: "ignore", notice: false };
}
