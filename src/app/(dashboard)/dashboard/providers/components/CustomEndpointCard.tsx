"use client";

import Link from "next/link";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import * as Shared from "@/shared/components";
import EndpointIcon from "@/shared/components/EndpointIcon";
import { MIMIC_LABELS, type Mimic } from "@/shared/utils/nodeQuirks.js";

// The shared components are untyped JS; re-type the props used here.
const Card = Shared.Card as unknown as ComponentType<{ padding?: string; className?: string; children?: ReactNode }>;
const Badge = Shared.Badge as unknown as ComponentType<{ variant?: string; size?: string; dot?: boolean; className?: string; children?: ReactNode }>;
const Toggle = Shared.Toggle as unknown as ComponentType<{ size?: string; checked: boolean; onChange: () => void; ariaLabel?: string }>;

// One pill per API family the endpoint answers on (mockup PROTOCOLS.short).
const PROTOCOL_SHORT: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-chat": "OpenAI",
  "openai-responses": "OpenAI",
};

const PILL = "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium leading-[1.45] border-border text-text-muted";

export interface CustomEndpointInfo {
  id: string;
  name: string;
  apiType?: string;
  baseUrl?: string;
  modelRoutes?: Record<string, string>;
  /** false only when it was saved without a working check. */
  verified?: boolean;
  icon?: string | null;
  iconUrl?: string | null;
  /** Letter-tile colour picked on the endpoint page. */
  tint?: string | null;
  mimic?: Mimic;
  stripBeta?: boolean;
  droppedBetas?: string[];
}

export interface CustomEndpointStats {
  connected: number;
  error: number;
  errorCode?: string | null;
  total: number;
  allDisabled: boolean;
}

// The protocols it speaks by itself, plus any its routed models go to instead.
function protocolLabels(p: CustomEndpointInfo): string[] {
  const own = p.id.startsWith("anthropic-compatible") ? "anthropic" : p.apiType === "responses" ? "openai-responses" : "openai-chat";
  const labels = [own, ...Object.values(p.modelRoutes || {})].map((k) => PROTOCOL_SHORT[k]).filter(Boolean);
  return [...new Set(labels)];
}

function hostOf(url?: string): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

export const betaFixText = (p: CustomEndpointInfo): string =>
  p.stripBeta ? "Auto-fixed: sending no beta flags" : `Auto-fixed: dropping ${(p.droppedBetas || []).join(", ")}`;

/**
 * Card for a user-added endpoint (mockups/provider-setup endpointCard): the app
 * icon, a status badge, then a protocol pill, a model count and an auto-fix mark.
 */
export default function CustomEndpointCard({
  provider,
  stats,
  modelCount,
  onToggle,
}: {
  provider: CustomEndpointInfo;
  stats: CustomEndpointStats;
  /** Saved models for this endpoint; null while still loading. */
  modelCount: number | null;
  onToggle: (enable: boolean) => void;
}) {
  const { connected, error, errorCode, total, allDisabled } = stats;
  const mimic = provider.mimic && provider.mimic !== "none" ? MIMIC_LABELS[provider.mimic] || provider.mimic : null;
  const autoFixed = !!provider.stripBeta || !!provider.droppedBetas?.length;

  let status: ReactNode;
  if (allDisabled) {
    status = <Badge size="sm">Disabled</Badge>;
  } else if (error > 0 && connected === 0) {
    status = (
      <span title={errorCode ? `Error ${errorCode}` : undefined}>
        <Badge variant="error" size="sm" dot className="whitespace-nowrap">
          {error === 1 ? "1 key failing" : `${error} keys failing`}
        </Badge>
      </span>
    );
  } else if (provider.verified === false) {
    status = <Badge variant="warning" size="sm" dot>Unverified</Badge>;
  } else {
    status = (
      <Badge variant="success" size="sm" dot className="whitespace-nowrap">
        {total ? `${total} key${total === 1 ? "" : "s"} · active` : "no key · active"}
      </Badge>
    );
  }

  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Link
      href={`/dashboard/providers/${provider.id}`}
      title={hostOf(provider.baseUrl) || undefined}
      data-provider-id={provider.id}
      className="group/card min-w-0"
    >
      <Card
        padding="xs"
        className={`relative flex h-full min-h-[104px] min-w-0 cursor-pointer flex-col justify-center transition-colors hover:bg-black/[0.01] dark:hover:bg-white/[0.01] ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <EndpointIcon name={provider.name} icon={provider.icon || provider.iconUrl} tint={provider.tint} size={40} impersonating={mimic} />
          <div className="min-w-0 flex-1">
            <h3 className="flex min-w-0 items-center gap-1">
              <span className="truncate font-semibold">{provider.name}</span>
            </h3>
            <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
              <span className="shrink-0">{status}</span>
              {total > 0 && (
                // Hidden until hover on wide screens, so the card rests like the mockup.
                <div
                  className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/card:opacity-100 sm:focus-within:opacity-100"
                  onClick={(e) => {
                    stop(e);
                    onToggle(allDisabled);
                  }}
                >
                  <Toggle
                    size="sm"
                    checked={!allDisabled}
                    onChange={() => {}}
                    ariaLabel={`${allDisabled ? "Enable" : "Disable"} ${provider.name}`}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
          {protocolLabels(provider).map((label) => (
            <span key={label} className={PILL}>{label}</span>
          ))}
          {modelCount !== null && (
            <span className={PILL}>{modelCount === 1 ? "1 model" : `${modelCount} models`}</span>
          )}
          {autoFixed && (
            <span
              title={betaFixText(provider)}
              aria-label="Auto-fixed"
              className="inline-flex size-[24px] shrink-0 items-center justify-center rounded-full border border-border text-text-muted"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[13px]">auto_fix_high</span>
            </span>
          )}
        </div>
      </Card>
    </Link>
  );
}
