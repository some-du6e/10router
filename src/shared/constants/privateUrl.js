// The answer when a dashboard request points the server at an internal host it
// may not use (see src/lib/network/privateUrls.ts).
export const PRIVATE_URL_ERROR =
  "URL not allowed: it points at a private, LAN or loopback host. Open the dashboard on this machine, or set ALLOW_PRIVATE_ENDPOINT_URLS=true.";
