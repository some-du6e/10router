import { NextResponse } from "next/server";
import { busyInstallMessage, busyInstallPids, killAppProcesses } from "@/lib/appUpdater";

// Shutdown app to release file locks for manual update
export async function POST() {
  let busy = [];
  try {
    busy = busyInstallPids();
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({
    success: true,
    message: "Shutting down for manual update...",
    // A manual `npm i -g` on Windows fails while another copy of this install runs.
    ...(busy.length > 0 ? { warning: busyInstallMessage(busy) } : {}),
  });

  setTimeout(() => process.exit(0), 500);

  return response;
}
