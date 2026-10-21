import dns from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { assertPublicUrl, assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";

const MAX_REDIRECTS = 3;

// The fetch shape probes use. Matches the global fetch; undici's own fetch is
// adapted to it at the call site.
export type ProbeFetch = (url: string, init?: RequestInit) => Promise<Response>;

// Resolve once, check the addresses, and hand back a dispatcher whose connect
// uses exactly those addresses. Without the pin, a DNS-rebinding host could
// answer the check with a public IP and the connect with 127.0.0.1.
async function pinnedDispatcher(target: string): Promise<Agent | null> {
  const { hostname } = new URL(target);
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) { assertPublicUrl(target); return null; } // literal: nothing to rebind
  const addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  // Re-run the guard against each resolved literal (same rules as the URL check).
  for (const { address, family } of addresses) {
    assertPublicUrl(`http://${family === 6 ? `[${address}]` : address}/`);
  }
  if (!addresses.length) throw new Error("Host did not resolve");
  const lookup: LookupFunction = (_h, opts, cb) => (opts?.all ? cb(null, addresses) : cb(null, addresses[0].address, addresses[0].family));
  return new Agent({ connect: { lookup } });
}

// fetch for probes: SSRF check on every hop for remote callers (with the
// connection pinned to the checked IPs), and redirects are followed only within
// the same origin so the key never goes to another host.
// Local callers may probe private hosts by design (ollama, LM Studio, vLLM).
export function makeProbeFetch(checkPublic: boolean, { fetchImpl }: { fetchImpl?: ProbeFetch } = {}): ProbeFetch {
  return async (url, init) => {
    let current = url;
    for (let hop = 0; ; hop++) {
      // init.signal (timeout + client abort) goes to the fetch below; check it
      // here too so a cancelled probe doesn't resolve DNS or follow a redirect.
      init?.signal?.throwIfAborted();
      let dispatcher: Agent | null = null;
      if (checkPublic) {
        await assertPublicUrlResolved(current);
        dispatcher = await pinnedDispatcher(current);
      }
      // undici's own fetch: the dispatcher must come from the same undici.
      const doFetch = (fetchImpl || (dispatcher ? undiciFetch : fetch)) as (url: string, init: RequestInit & { dispatcher?: Agent }) => Promise<Response>;
      let res: Response;
      try {
        res = await doFetch(current, { ...init, redirect: "manual", ...(dispatcher ? { dispatcher } : {}) });
      } finally {
        // The body is read by the caller; closing gracefully waits for it.
        dispatcher?.close().catch(() => {});
      }
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
