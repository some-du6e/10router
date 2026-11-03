import { getProviderConnections, getProviderNodes } from "@/lib/db/index.js";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers.js";

type NamedRow = { id?: string; name?: string | null; email?: string | null };

export type ProviderLabeler = {
  providerName: (providerId: string | null | undefined) => string | null | undefined;
  connectionName: (connectionId: string | null | undefined) => string | null;
};

// Display names for the provider and key ids stored on usage rows. Custom
// endpoints are stored under generated ids (openai-compatible-chat-<uuid>), so
// their names come from the provider nodes, not the static provider list.
export async function getProviderLabeler(): Promise<ProviderLabeler> {
  const [nodes, connections] = await Promise.all([
    getProviderNodes().catch(() => []) as Promise<NamedRow[]>,
    getProviderConnections().catch(() => []) as Promise<NamedRow[]>,
  ]);
  const nodeNames = new Map<string, string>();
  for (const node of nodes) if (node.id && node.name) nodeNames.set(node.id, node.name);
  const connectionNames = new Map<string, string>();
  for (const c of connections) {
    const name = c.name || c.email;
    if (c.id && name) connectionNames.set(c.id, name);
  }

  return {
    providerName(providerId) {
      if (!providerId) return providerId;
      const known = getProviderByAlias(providerId) || (AI_PROVIDERS as Record<string, { name?: string }>)[providerId];
      return nodeNames.get(providerId) || known?.name || providerId;
    },
    connectionName(connectionId) {
      return (connectionId && connectionNames.get(connectionId)) || null;
    },
  };
}

export function labelRequestDetail<T extends { provider?: string; connectionId?: string }>(detail: T, labels: ProviderLabeler) {
  return {
    ...detail,
    providerName: labels.providerName(detail.provider),
    connectionName: labels.connectionName(detail.connectionId),
  };
}
