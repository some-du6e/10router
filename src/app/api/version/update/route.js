import { NextResponse } from "next/server";
import { busyInstallMessage, busyInstallPids, killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";

export async function POST() {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (10router CLI)" },
      { status: 403 }
    );
  }

  // On Windows npm can't replace files another running copy of this install holds.
  const busy = busyInstallPids();
  if (busy.length > 0) {
    return NextResponse.json({ success: false, message: busyInstallMessage(busy) }, { status: 409 });
  }

  try {
    // Stop this install's launcher, tray, tunnel and updater to release file locks on Windows
    await killAppProcesses();
  } catch { /* best effort */ }

  // Schedule detached updater then exit current server process
  spawnUpdaterAndExit();

  return NextResponse.json({ success: true, message: "Updater started. This app will exit shortly." });
}
