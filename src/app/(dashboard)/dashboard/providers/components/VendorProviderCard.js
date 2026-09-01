"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { Card, Badge } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { AAII_SCORES, AAII_INDEX_VERSION } from "@/shared/constants/providerVendors";

// How many endpoint pills fit on one line before the rest collapse behind "+N".
// The row is nowrap so a card can never grow a second line and break the grid.
const VISIBLE_PILLS = 3;

function EndpointPill({ route }) {
  const { label, href, connected, error, errorCode, allDisabled, isReady } = route;

  let tone = "border-border border-dashed text-text-subtle group-hover/card:text-text-muted";
  let lead = <span className="material-symbols-outlined text-[12px]">add</span>;
  let title = `${label} — not connected`;

  if (allDisabled) {
    tone = "bg-surface-2 text-text-muted border-transparent";
    lead = <span className="material-symbols-outlined text-[12px]">pause_circle</span>;
    title = `${label} — disabled`;
  } else if (error > 0 && connected === 0) {
    tone = "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20";
    lead = <span className="size-[5px] shrink-0 rounded-full bg-current" />;
    title = `${label} — ${error} error${errorCode ? ` (${errorCode})` : ""}`;
  } else if (connected > 0 || isReady) {
    tone = "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20";
    lead = <span className="size-[5px] shrink-0 rounded-full bg-current" />;
    title = connected > 0 ? `${label} — ${connected} connected` : `${label} — ready`;
  }

  return (
    <Link
      href={href}
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium leading-[1.45] transition-colors ${tone}`}
    >
      {lead}
      {label}
      {connected > 1 && (
        <span className="font-bold tabular-nums opacity-70">{connected}</span>
      )}
      {connected > 0 && error > 0 && (
        <span
          className="size-[5px] shrink-0 rounded-full bg-red-500"
          title={`${error} error${errorCode ? ` (${errorCode})` : ""}`}
        />
      )}
    </Link>
  );
}

EndpointPill.propTypes = {
  route: PropTypes.shape({
    label: PropTypes.string.isRequired,
    href: PropTypes.string.isRequired,
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    allDisabled: PropTypes.bool,
    isReady: PropTypes.bool,
  }).isRequired,
};

/**
 * One card for a vendor with several registry endpoints (OpenAI = Codex + API +
 * Azure). Every endpoint is shown at once as its own pill carrying its own
 * connection state — there is nothing to switch between, and each pill links
 * straight to that endpoint's detail page.
 */
export default function VendorProviderCard({ vendor, routes }) {
  const [expanded, setExpanded] = useState(false);

  const activeCount = routes.filter((r) => r.connected > 0 || r.isReady).length;
  const visible = expanded ? routes : routes.slice(0, VISIBLE_PILLS);
  const hiddenCount = routes.length - visible.length;
  const aaii = AAII_SCORES[vendor.id];

  return (
    <Link href={routes[0].href} className="group/card min-w-0">
      <Card
        padding="xs"
        className="flex h-full min-h-[104px] min-w-0 flex-col justify-center overflow-hidden transition-colors hover:bg-black/[0.01] dark:hover:bg-white/[0.01] cursor-pointer"
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="size-8 shrink-0 rounded-lg flex items-center justify-center"
              style={{
                backgroundColor: `${vendor.color?.length > 7 ? vendor.color : vendor.color + "15"}`,
              }}
            >
              <ProviderIcon
                src={getProviderIconSrc(vendor.icon)}
                alt={vendor.name}
                size={30}
                className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
                fallbackText={vendor.name.slice(0, 2).toUpperCase()}
                fallbackColor={vendor.color}
              />
            </div>
            <div className="min-w-0">
              <h3 className="flex min-w-0 items-center gap-1.5 font-semibold">
                <span className="truncate">{vendor.name}</span>
                {aaii && (
                  <span
                    title={`Artificial Analysis Intelligence Index ${AAII_INDEX_VERSION} — ${aaii.model}`}
                    className="shrink-0 rounded-[5px] bg-primary/15 px-1.5 py-[2px] text-[9.5px] font-bold leading-none tabular-nums text-primary"
                  >
                    {aaii.score}
                  </span>
                )}
              </h3>
              <div className="flex min-w-0 items-center gap-1.5 text-xs">
                {activeCount > 0 ? (
                  <Badge variant="success" size="sm" dot>
                    {activeCount} of {routes.length} active
                  </Badge>
                ) : (
                  <span className="text-text-muted">
                    {routes.length} endpoints
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
          {visible.map((route) => (
            <EndpointPill key={route.id} route={route} />
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setExpanded(true);
              }}
              title={`Show ${hiddenCount} more endpoint${hiddenCount > 1 ? "s" : ""}`}
              className="inline-flex shrink-0 items-center rounded-full bg-surface-2 px-2.5 py-[3px] text-[11px] font-semibold leading-[1.45] text-text-muted transition-colors hover:bg-surface-3 hover:text-text-main"
            >
              +{hiddenCount}
            </button>
          )}
        </div>
      </Card>
    </Link>
  );
}

VendorProviderCard.propTypes = {
  vendor: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    icon: PropTypes.string.isRequired,
    color: PropTypes.string,
  }).isRequired,
  routes: PropTypes.arrayOf(PropTypes.object).isRequired,
};
