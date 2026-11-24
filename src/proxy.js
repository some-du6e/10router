import { proxy as dashboardProxy } from "./dashboardGuard";
import { releaseBodyCopy } from "@/lib/proxyBodyCopy.js";

export default async function proxy(request) {
  releaseBodyCopy(request);
  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
