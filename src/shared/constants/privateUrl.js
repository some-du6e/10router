// The answer when a request points the server at an internal host it may not
// use (see src/lib/network/privateUrls.ts). Worded for every caller: the
// variable only helps signed-in dashboard sessions, never the management API
// or an instance with login off.
export const PRIVATE_URL_ERROR =
  "URL not allowed: it points at a private, LAN or loopback host. Open the dashboard on this machine or, with login on, set ALLOW_PRIVATE_ENDPOINT_URLS=true for signed-in sessions.";
