import { GITLAB_CONFIG } from "./constants/oauth.js";
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";
import { blocksPrivateUrls, PRIVATE_URL_ERROR } from "@/lib/network/privateUrls.js";

export const GITLAB_DEFAULT_BASE: string = GITLAB_CONFIG.defaultBaseUrl;

// A GitLab instance URL: http(s), no credentials, query or fragment (those
// would swallow the API path appended after it). Empty means the registry's
// default (gitlab.com). Returns null when the value isn't usable.
export function normalizeGitlabBaseUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return GITLAB_DEFAULT_BASE;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return GITLAB_DEFAULT_BASE;
  if (trimmed.includes("?") || trimmed.includes("#")) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

// The instance a GitLab sign-in (PAT or OAuth) may use, and whether its probes
// must check every hop (`remote`). A caller who may not reach internal hosts
// (see blocksPrivateUrls) only gets public ones; others keep a LAN GitLab.
export async function resolveGitlabBase(request: Request, raw: unknown): Promise<{ base: string; remote: boolean } | { error: string }> {
  const base = normalizeGitlabBaseUrl(raw);
  if (!base) return { error: "Invalid GitLab URL" };
  const remote = await blocksPrivateUrls(request);
  if (remote) {
    try { await assertPublicUrlResolved(base); } catch { return { error: PRIVATE_URL_ERROR }; }
  }
  return { base, remote };
}
