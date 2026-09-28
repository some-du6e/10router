import REGISTRY from "../../../open-sse/providers/registry/index.js";

const providerNames = new Map(REGISTRY.map((provider) => [provider.id, provider.display?.name]));
providerNames.set("codex", "Codex");

export function notificationProviderName(provider) {
  if (!provider) return "Provider";
  return providerNames.get(provider) || provider;
}
