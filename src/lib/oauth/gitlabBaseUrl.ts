import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard.js";

export const GITLAB_DEFAULT_BASE = "https://gitlab.com";

// A GitLab instance URL: http(s), no credentials, query or fragment (those
// would swallow the API path appended after it). Empty means gitlab.com.
// Returns null when the value isn't usable.
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

// Remote callers may only point at public GitLab hosts; local callers may use a
// self-hosted instance on their own network.
export async function isAllowedGitlabBase(base: string, remote: boolean): Promise<boolean> {
  if (!remote) return true;
  try {
    await assertPublicUrlResolved(base);
    return true;
  } catch {
    return false;
  }
}
