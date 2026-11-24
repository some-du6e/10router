import type { Dispatcher } from "undici";
import { fetch as undiciFetch } from "undici";
import { pinnedAgent, resolvePublicAddresses } from "@/shared/utils/ssrfGuard.js";
import { envProxyDispatcher } from "open-sse/utils/envProxy.js";

const MAX_REDIRECTS = 3;

// The fetch shape probes use. Matches the global fetch; undici's own fetch is
// adapted to it at the call site.
export type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>;

// For a remote caller: check the target and resolve it once (a name that
// doesn't resolve is refused). When the environment's proxy (HTTPS_PROXY,
// HTTP_PROXY, ALL_PROXY, NO_PROXY respected) covers the target, the probe goes
// through it; the proxy resolves the name again, so the pin can't apply there.
// Otherwise the connection is pinned to the checked addresses, so a
// DNS-rebinding host can't answer the check with a public IP and the connect
// with 127.0.0.1. `owned` dispatchers are closed after the hop.
async function checkedDispatcher(target: string): Promise<{ dispatcher: Dispatcher | null; owned: boolean }> {
  const addresses = await resolvePublicAddresses(target);
  const proxy = envProxyDispatcher(target) as Dispatcher | null;
  if (proxy) return { dispatcher: proxy, owned: false };
  return addresses ? { dispatcher: pinnedAgent(addresses), owned: true } : { dispatcher: null, owned: false };
}

// fetch for probes: SSRF check on every hop for remote callers (with the
// connection pinned to the checked IPs, or through the env proxy), and
// redirects are followed only within the same origin so the key never goes to
// another host, for local callers too (describeRedirect words the refusal). A
// caller that asks for `redirect: "manual"` gets the first answer, a redirect
// included, unfollowed (it follows hops itself, each through this fetch, or
// treats one as an answer). Local callers may probe private hosts by design
// (ollama, LM Studio, vLLM), through the global fetch and its env proxy.
export function makeProbeFetch(checkPublic: boolean, { fetchImpl }: { fetchImpl?: ProbeFetch } = {}): ProbeFetch {
  return async (url, init) => {
    let current = url;
    for (let hop = 0; ; hop++) {
      // init.signal (timeout + client abort) goes to the fetch below; check it
      // here too so a cancelled probe doesn't resolve DNS or follow a redirect.
      init?.signal?.throwIfAborted();
      const { dispatcher, owned } = checkPublic ? await checkedDispatcher(current) : { dispatcher: null, owned: false };
      // undici's own fetch: the dispatcher must come from the same undici.
      const doFetch = (fetchImpl || (checkPublic ? undiciFetch : fetch)) as (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;
      let res: Response;
      try {
        res = await doFetch(current, { ...init, redirect: "manual", ...(dispatcher ? { dispatcher } : {}) });
      } finally {
        // The body is read by the caller; closing gracefully waits for it.
        if (owned) dispatcher?.close().catch(() => {});
      }
      if (init?.redirect === "manual") return res;
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      const next = new URL(location, current);
      if (next.origin !== new URL(current).origin || hop >= MAX_REDIRECTS) return res;
      // A POST that would turn into a GET means the URL is wrong; report the redirect as-is.
      if (init?.method === "POST" && (res.status === 301 || res.status === 302 || res.status === 303)) return res;
      // Following: drop this hop's body so its pinned agent can close.
      await res.body?.cancel().catch(() => {});
      current = next.toString();
    }
  };
}

// A redirect makeProbeFetch declined to follow (another origin, or POST→GET),
// worded so the user can fix the URL rather than see a bare status code.
export function describeRedirect(res: Response): string | null {
  if (res.status < 300 || res.status >= 400) return null;
  const location = res.headers.get("location");
  if (!location) return null;
  try {
    return `The server redirected to ${new URL(location, res.url || undefined).origin}. Use that URL instead.`;
  } catch {
    return "The server redirected elsewhere. Use the final URL instead.";
  }
}
