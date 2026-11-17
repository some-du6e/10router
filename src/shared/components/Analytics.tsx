"use client";

import { GoogleAnalytics } from "@next/third-parties/google";
import { usePathname } from "next/navigation";

// Pages whose URL can carry OAuth codes or tokens. Analytics would send that
// URL with its page view, so it never loads there.
export function analyticsAllowedOn(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname !== "/callback" && !pathname.startsWith("/callback/");
}

export default function Analytics({ gaId }: { gaId: string }) {
  const pathname = usePathname();
  if (!gaId || !analyticsAllowedOn(pathname)) return null;
  return <GoogleAnalytics gaId={gaId} />;
}
