import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";

const MAX_REDIRECTS = 3;

// fetch for probes: SSRF check on every hop for remote callers, and redirects are
// followed only within the same origin so the key never goes to another host.
export function makeProbeFetch(checkPublic) {
  return async (url, init) => {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (checkPublic) await assertPublicUrlResolved(current);
      const res = await fetch(current, { ...init, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      const next = new URL(location, current);
      if (next.origin !== new URL(current).origin || hop >= MAX_REDIRECTS) return res;
      // A POST that would turn into a GET means the URL is wrong; report the redirect as-is.
      if (init?.method === "POST" && (res.status === 301 || res.status === 302 || res.status === 303)) return res;
      current = next.toString();
    }
  };
}
