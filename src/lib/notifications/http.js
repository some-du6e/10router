import dns from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import { NOTIFICATION_CONFIG } from "./constants.js";
import { isPrivateNotificationHost } from "./validation.js";

function isPrivateAddress(address) {
  return isPrivateNotificationHost(address);
}

async function assertPublicDestination(url, allowPrivateNetwork = false) {
  if (allowPrivateNetwork) return null;
  if (isPrivateNotificationHost(url.hostname)) {
    throw new Error("Private or local notification destinations require the private-network option");
  }

  const family = isIP(url.hostname);
  if (family) return [{ address: url.hostname, family }];

  const results = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!results.length) throw new Error("Notification destination did not resolve");
  if (results.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Notification destination resolves to a private or local address");
  }
  return results;
}

export function createPinnedLookup(address) {
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

async function readResponseText(response) {
  if (!response.body?.getReader) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (bytes < NOTIFICATION_CONFIG.maxResponseChars && text.length < NOTIFICATION_CONFIG.maxResponseChars) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      const remainingBytes = NOTIFICATION_CONFIG.maxResponseChars - bytes;
      const chunk = value.subarray(0, remainingBytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < value.byteLength || bytes >= NOTIFICATION_CONFIG.maxResponseChars || text.length >= NOTIFICATION_CONFIG.maxResponseChars) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return text.slice(0, NOTIFICATION_CONFIG.maxResponseChars);
  } catch {
    return text.slice(0, NOTIFICATION_CONFIG.maxResponseChars);
  } finally {
    reader.releaseLock();
  }
}

export async function notificationFetch(urlValue, options = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const assertDestination = deps.assertDestination || assertPublicDestination;
  const createDispatcher = deps.createDispatcher || ((address) => new Agent({
    connect: { lookup: createPinnedLookup(address) },
  }));
  const url = new URL(urlValue);
  const addresses = await assertDestination(url, options.allowPrivateNetwork === true);
  const dispatcher = addresses?.length ? createDispatcher(addresses[0]) : null;
  const { allowPrivateNetwork, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTIFICATION_CONFIG.requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...fetchOptions,
      redirect: "manual",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
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
    await dispatcher?.close().catch(() => {});
  }
}
