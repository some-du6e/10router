import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashManagementKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

export function createManagementKey() {
  const key = `hub_${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashManagementKey(key) };
}

export function authorizeHub(request, settings) {
  if (settings.usageHubEnabled !== true) return 404;
  const header = request.headers.get("authorization") || "";
  const stored = settings.usageHubKeyHash;
  if (!header.startsWith("Bearer ") || !/^[a-f0-9]{64}$/.test(stored || "")) return 401;
  const actual = Buffer.from(hashManagementKey(header.slice(7)), "hex");
  return timingSafeEqual(actual, Buffer.from(stored, "hex")) ? null : 401;
}

export function hubConfig(settings) {
  return {
    enabled: settings.usageHubEnabled === true,
    keyConfigured: !!settings.usageHubKeyHash,
    demo: process.env.TENROUTER_HUB_DEMO === "true",
  };
}
