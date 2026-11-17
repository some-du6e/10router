import { isLocalRequest } from "@/dashboardGuard";

export const ALLOW_PRIVATE_URLS_ENV = "ALLOW_PRIVATE_ENDPOINT_URLS";

// True when a dashboard request may not point the server at an internal host
// (endpoint and key URLs, their probes, a GitLab instance). Local callers may.
// So may remote ones when the operator sets ALLOW_PRIVATE_ENDPOINT_URLS=true:
// a session through a reverse proxy, or (usually) through a Docker published
// port, never counts as local, yet its model servers may sit on the LAN.
export function blocksPrivateUrls(request: Request): boolean {
  if (process.env[ALLOW_PRIVATE_URLS_ENV] === "true") return false;
  return !isLocalRequest(request);
}
