import { NextResponse } from "next/server";
import { enableTailscale } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";
import { validatePassword } from "@/lib/tunnel/tailscale/sudo.js";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try { validatePassword(body.sudoPassword); } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  try {
    const result = await enableTailscale(20128, body.sudoPassword);
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tailscale monitor start failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale enable error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
