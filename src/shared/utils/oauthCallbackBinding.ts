export interface CallbackData {
  code?: string | null;
  token?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}

export interface PendingAuth {
  state?: string | null;
  proxyProvider?: string | null;
  redirectUri?: string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Their authorize URL carries no state, so their callback can't echo one.
// Their "code" is the credential itself, so it is taken only from the popup
// this dialog opened, never from a broadcast or localStorage relay.
export const STATELESS_CALLBACK_PROVIDERS: ReadonlySet<string> = new Set(["cline", "clinepass"]);

// Their callback goes to a local proxy that exchanges it on the server. A
// callback relayed by /callback is never theirs.
export const PROXY_OAUTH_PROVIDERS: ReadonlySet<string> = new Set(["trae", "windsurf", "zed"]);

export function isTrustedCallbackOrigin(origin: string, ownOrigin: string): boolean {
  if (origin === ownOrigin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// A popup name of its own for each login. window.open with a fixed name reuses
// any window already carrying it, even one another page opened.
export function newPopupName(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `oauth_popup_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Whether a postMessage came from the popup this dialog opened for this login.
export function isOwnPopup(source: unknown, popup: unknown): boolean {
  return source != null && popup != null && source === popup;
}

function originOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

export type RelayChannel = "message" | "broadcast" | "storage";

export interface RelayContext {
  provider: string | null | undefined;
  authData: PendingAuth | null | undefined;
  // The login already took a callback.
  processed: boolean;
  via: RelayChannel;
  // A postMessage whose event.source is the popup this dialog opened (isOwnPopup).
  fromOwnPopup?: boolean;
  // A postMessage's event.origin.
  origin?: string | null;
}

export interface RelayDeps {
  markProcessed(): void;
  notice(): void;
  fail(message: string): void;
  exchange(code: string, state: string | null): unknown;
}

export type RelayResult = "ignored" | "failed" | "exchanged";

function sentState(authData: PendingAuth): string | null {
  return typeof authData.state === "string" && authData.state !== "" ? authData.state : null;
}

// Whether a relayed callback belongs to the pending login.
export function isCallbackForPendingAuth(data: CallbackData | null | undefined, ctx: RelayContext): boolean {
  const { provider, authData } = ctx;
  if (!data || !authData || !provider) return false;
  if (PROXY_OAUTH_PROVIDERS.has(provider) || authData.proxyProvider) return false;
  if (STATELESS_CALLBACK_PROVIDERS.has(provider)) {
    // From our popup, and sent by the page at the redirect URI this login named.
    const redirectOrigin = originOf(authData.redirectUri);
    return ctx.via === "message" && ctx.fromOwnPopup === true && !data.state &&
      redirectOrigin !== null && ctx.origin === redirectOrigin;
  }
  const state = sentState(authData);
  return state !== null && data.state === state;
}

// Everything the connect dialog does with a relayed callback. Anything that
// isn't this login's callback leaves the login pending, so the real callback is
// still taken when it arrives.
export async function handleRelayedCallback(
  data: CallbackData | null | undefined,
  ctx: RelayContext,
  deps: RelayDeps,
): Promise<RelayResult> {
  if (ctx.processed) return "ignored";
  const carriesSomething = !!(data?.code || data?.token || data?.error);
  if (!data || !isCallbackForPendingAuth(data, ctx)) {
    if (carriesSomething) deps.notice();
    return "ignored";
  }
  if (data.error) {
    deps.markProcessed();
    deps.fail(data.errorDescription || data.error);
    return "failed";
  }
  const code = data.token || data.code;
  if (!code) return "ignored";
  deps.markProcessed();
  await deps.exchange(code, data.state ?? null);
  return "exchanged";
}

// A pasted callback URL whose state names another login is refused. One with no
// state is the user's own call (some providers don't echo it).
export function checkPastedState(
  pastedState: string | null | undefined,
  authData: PendingAuth | null | undefined,
  provider: string | null | undefined,
): string | null {
  if (!authData || !provider || STATELESS_CALLBACK_PROVIDERS.has(provider)) return null;
  const state = sentState(authData);
  if (!state || !pastedState || pastedState === state) return null;
  return "This URL is from a different sign-in, not the one this dialog started. Start again, or paste the URL from the sign-in you just finished.";
}

export type PastedCallback =
  | { action: "exchange"; code: string; state: string | null }
  | { action: "xai-code"; code: string }
  | { action: "error"; message: string };

// What the connect dialog's paste step does with what the user pasted.
export function parsePastedCallback(
  input: string | null | undefined,
  authData: PendingAuth | null | undefined,
  provider: string | null | undefined,
): PastedCallback {
  const value = String(input || "").trim();
  // A raw JWT access token.
  if (value.startsWith("eyJ") && value.includes(".")) return { action: "exchange", code: value, state: null };
  // xAI can show a code instead of redirecting; Kimchi can hand over a bare token.
  if (provider === "xai" && value && !value.includes("://") && !value.includes("?") && !value.includes("code=")) {
    return { action: "xai-code", code: value };
  }
  if (provider === "kimchi" && value && !value.includes("://") && !value.includes("?")) {
    return { action: "exchange", code: value, state: null };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { action: "error", message: "Paste the full callback URL from your browser's address bar." };
  }
  const code = url.searchParams.get("code");
  const token = url.searchParams.get("token");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const stateProblem = checkPastedState(state, authData, provider);
  if (stateProblem) return { action: "error", message: stateProblem };
  if (error) return { action: "error", message: url.searchParams.get("error_description") || error };
  const credential = token || code;
  if (!credential) {
    return {
      action: "error",
      message: provider === "xai"
        ? "Paste the callback URL or copied xAI code"
        : provider === "kimchi"
          ? "No Kimchi token found in URL"
          : "No authorization code found in URL",
    };
  }
  return { action: "exchange", code: credential, state };
}
