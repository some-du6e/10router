// The app-icon tile for a user-added endpoint (mockups/provider-setup appIcon +
// markedIcon): the site's own icon filling an iOS-style rounded tile, else a
// coloured letter, plus a yellow mask badge on the corner when the endpoint
// impersonates a client (quirk `mimic`). Used by the providers grid cards, the
// endpoint page header and the Add endpoint dialog.

import type { CSSProperties } from "react";

// Same palette and hash as the mockup, so a name gets the same colour everywhere.
export const TILE_BG = ["#0ea5e9", "#8b5cf6", "#f43f5e", "#f59e0b", "#10b981", "#64748b"] as const;

export function tileColor(name: string): string {
  const n = (name || "?").trim() || "?";
  return TILE_BG[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % TILE_BG.length];
}

export interface EndpointIconProps {
  /** Endpoint name; its first letter is the fallback tile. */
  name: string;
  /** Site icon (a data: URL saved with the node, or a same-origin URL). */
  icon?: string | null;
  /** Tile edge in px. Cards use 40, the dialog 24. */
  size?: number;
  /** Label of the client being impersonated ("Claude Code"); shows the corner mask. */
  impersonating?: string | null;
  /** Fixed tile colour instead of the name hash. */
  tint?: string | null;
  className?: string;
}

export default function EndpointIcon({ name, icon, size = 40, impersonating, tint, className = "" }: EndpointIconProps) {
  const r = Math.round(size * 0.225);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: r,
    boxShadow: "0 1px 2px rgb(0 0 0 / .12), 0 2px 6px rgb(0 0 0 / .06)",
  };
  const letter = ((name || "?").trim()[0] || "?").toUpperCase();
  const bg = tint || tileColor(name);
  const tile = (
    <span className={`relative inline-flex shrink-0 overflow-hidden ${impersonating ? "" : className}`} style={style} aria-hidden="true">
      {icon ? (
        // A data: URL copied server-side; never hotlinked.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" src={icon} className="block size-full object-cover" />
      ) : (
        <span
          className="flex size-full items-center justify-center font-semibold text-white"
          style={{ background: `linear-gradient(160deg,${bg}cc,${bg})`, fontSize: Math.round(size * 0.42) }}
        >
          {letter}
        </span>
      )}
      {/* Hairline edge, like an iOS home-screen icon. */}
      <span
        className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_.5px_rgb(0_0_0/.14)] dark:shadow-[inset_0_0_0_.5px_rgb(255_255_255/.14)]"
        style={{ borderRadius: "inherit" }}
      />
    </span>
  );
  if (!impersonating) return tile;
  const d = Math.round(size * 0.42);
  const label = `Impersonating ${impersonating}`;
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      {tile}
      <span
        title={label}
        role="img"
        aria-label={label}
        className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full bg-yellow-400 text-yellow-950 ring-2 ring-surface"
        style={{ width: d, height: d }}
      >
        <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: Math.round(d * 0.7) }}>
          theater_comedy
        </span>
      </span>
    </span>
  );
}
