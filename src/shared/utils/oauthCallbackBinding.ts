interface CallbackData {
  state?: string | null;
}

interface PendingAuth {
  state?: string | null;
  authUrl?: string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isTrustedCallbackOrigin(origin: string, ownOrigin: string): boolean {
  if (origin === ownOrigin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function sentState(authData: PendingAuth): boolean {
  if (!authData.state || !authData.authUrl) return false;
  try {
    return new URL(authData.authUrl).searchParams.get("state") === authData.state;
  } catch {
    return false;
  }
}

// A relayed callback belongs to the pending login only if it echoes the state we sent.
// Providers that are never sent a state (e.g. Cline) cannot echo one.
export function isCallbackForPendingAuth(data: CallbackData | null | undefined, authData: PendingAuth | null | undefined): boolean {
  if (!data || !authData) return false;
  if (data.state) return data.state === authData.state;
  return !sentState(authData);
}
