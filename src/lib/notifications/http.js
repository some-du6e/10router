import dns from "node:dns/promises";
import { isIP } from "node:net";
import { NOTIFICATION_CONFIG } from "./constants.js";
import { isPrivateNotificationHost } from "./validation.js";

function isPrivateAddress(address) {
  return isPrivateNotificationHost(address);
}

async function assertPublicDestination(url, allowPrivateNetwork = false) {
  if (allowPrivateNetwork) return;
  if (isPrivateNotificationHost(url.hostname)) {
    throw new Error("Private or local notification destinations require the private-network option");
  }
  if (isIP(url.hostname)) return;

  const results = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!results.length) throw new Error("Notification destination did not resolve");
  if (results.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Notification destination resolves to a private or local address");
  }
}

async function readResponseText(response) {
  try {
    return (await response.text()).slice(0, NOTIFICATION_CONFIG.maxResponseChars);
  } catch {
    return "";
  }
}

export async function notificationFetch(urlValue, options = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const assertDestination = deps.assertDestination || assertPublicDestination;
  const url = new URL(urlValue);
  await assertDestination(url, options.allowPrivateNetwork === true);
  const { allowPrivateNetwork, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTIFICATION_CONFIG.requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...fetchOptions,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Notification destination returned a redirect");
    }
    if (!response.ok) {
      const detail = await readResponseText(response);
      throw new Error(`Notification request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
