"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import { Card, Badge, Toggle } from "@/shared/components";

// Keyed by the route protocols in src/shared/utils/nodeQuirks.ts.
const API_LABELS = {
  anthropic: "Messages",
  "openai-chat": "Chat",
  "openai-responses": "Responses",
};

// The API a node speaks by itself, plus any its routed models go to instead.
function apiPaths(provider) {
  const own = provider.id.startsWith("anthropic-compatible")
    ? "anthropic"
    : provider.apiType === "responses"
      ? "openai-responses"
      : "openai-chat";
  const routed = Object.values(provider.modelRoutes || {});
  return [own, ...routed.filter((p, i) => p !== own && routed.indexOf(p) === i)]
    .filter((p) => API_LABELS[p]);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// Two letters from the name's words ("OpenCode Zen" -> "OZ"), else its first two.
function monogram(name) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "").slice(0, 2);
  return letters.toUpperCase() || "··";
}

// Vendor tiles are all different colours; give endpoints a stable one of their own.
const TILE_TONES = [
  "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
];

function tileTone(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_TONES[h % TILE_TONES.length];
}

/**
 * Card for a user-added OpenAI/Anthropic-compatible endpoint, laid out like
 * VendorProviderCard: a monogram instead of a borrowed vendor logo, a key
 * count, and one pill per API the endpoint answers on.
 */
export default function CustomEndpointCard({ provider, stats, onToggle }) {
  const { connected, error, errorCode, total, allDisabled } = stats;
  const href = `/dashboard/providers/${provider.id}`;
  const host = hostOf(provider.baseUrl);
  const paths = apiPaths(provider);

  // Same tones and lead marks as VendorProviderCard's EndpointPill.
  let pillTone = "border-border border-dashed text-text-subtle group-hover/card:text-text-muted";
  let lead = <span className="material-symbols-outlined text-[12px]">add</span>;
  if (allDisabled) {
    pillTone = "bg-surface-2 text-text-muted border-transparent";
    lead = <span className="material-symbols-outlined text-[12px]">pause_circle</span>;
  } else if (connected > 0 || error > 0) {
    pillTone = connected > 0
      ? "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
      : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20";
    lead = <span className="size-[5px] shrink-0 rounded-full bg-current" />;
  }

  return (
    <Link href={href} title={host || undefined} className="group/card min-w-0">
      <Card
        padding="xs"
        className={`flex h-full min-h-[104px] min-w-0 flex-col justify-center overflow-hidden transition-colors hover:bg-black/[0.01] dark:hover:bg-white/[0.01] cursor-pointer ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={`size-8 shrink-0 rounded-lg flex items-center justify-center text-[12px] font-bold tracking-tight ${tileTone(provider.id)}`}
          >
            {monogram(provider.name)}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold">{provider.name}</h3>
            <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
              {allDisabled ? (
                <span className="text-text-muted">Disabled</span>
              ) : connected > 0 || error > 0 ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  {connected > 0 && (
                    <Badge variant="success" size="sm" dot className="whitespace-nowrap">
                      {connected === 1 ? "1 key" : `${connected} keys`}
                    </Badge>
                  )}
                  {error > 0 && (
                    <span title={errorCode ? `Error ${errorCode}` : undefined}>
                      <Badge variant="error" size="sm" dot className="whitespace-nowrap">
                        {connected > 0 ? `${error} failing` : error === 1 ? "1 key failing" : `${error} keys failing`}
                      </Badge>
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-text-muted">
                  {total === 0 ? "No keys" : total === 1 ? "1 key, untested" : `${total} keys, untested`}
                </span>
              )}
              {total > 0 && (
                <div
                  className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/card:opacity-100 sm:focus-within:opacity-100"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
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
          {paths.map((p) => (
            <span
              key={p}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium leading-[1.45] transition-colors ${pillTone}`}
            >
              {lead}
              {API_LABELS[p]}
            </span>
          ))}
        </div>
      </Card>
    </Link>
  );
}

CustomEndpointCard.propTypes = {
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    apiType: PropTypes.string,
    baseUrl: PropTypes.string,
    modelRoutes: PropTypes.object,
  }).isRequired,
  stats: PropTypes.shape({
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    total: PropTypes.number,
    allDisabled: PropTypes.bool,
  }).isRequired,
  onToggle: PropTypes.func.isRequired,
};
