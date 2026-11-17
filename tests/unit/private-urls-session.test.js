// ALLOW_PRIVATE_ENDPOINT_URLS relaxes the private-host rule only for a real
// signed-in dashboard session: not with requireLogin off, not on an unclaimed
// instance, not for a restricted session, and not for the management API's
// internal requests, which carry no session cookie.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  needsSetup: vi.fn(),
  getDashboardAuthSession: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { next: vi.fn(), json: vi.fn(), redirect: vi.fn() } }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: vi.fn() }));
vi.mock("@/lib/auth/setupState", () => ({ needsSetup: mocks.needsSetup }));
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardAuthToken: vi.fn(), getDashboardAuthSession: mocks.getDashboardAuthSession }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn() }));
vi.mock("@/lib/db/helpers/metaStore.js", () => ({ getMeta: vi.fn(), setMeta: vi.fn() }));
vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: () => false }));

const { hasSignedInDashboardSession } = await import("../../src/dashboardGuard.js");
const { blocksPrivateUrls, privateUrlRejected, PRIVATE_URL_ERROR } = await import("../../src/lib/network/privateUrls.js");

// A request through the reverse proxy (never local), with or without the session cookie.
const browser = (cookie = "jwt") => ({
  headers: new Headers({ "x-9r-via-proxy": "1" }),
  cookies: { get: (name) => (name === "auth_token" && cookie ? { value: cookie } : undefined) },
});
// What the management API builds to call the dashboard routes (handlers.js internalJsonRequest).
const managementInternal = () => new Request("http://management.internal/api/providers/validate", { method: "POST" });

beforeEach(() => {
  vi.stubEnv("ALLOW_PRIVATE_ENDPOINT_URLS", "true");
  mocks.getSettings.mockResolvedValue({ requireLogin: true });
  mocks.needsSetup.mockResolvedValue(false);
  mocks.getDashboardAuthSession.mockImplementation(async (token) => (token ? { authenticated: true } : null)); // as the real one: no token, no session
});
afterEach(() => vi.unstubAllEnvs());

describe("ALLOW_PRIVATE_ENDPOINT_URLS and the session", () => {
  it("relaxes the rule for a signed-in session on a claimed instance with login required", async () => {
    expect(await hasSignedInDashboardSession(browser())).toBe(true);
    expect(await blocksPrivateUrls(browser())).toBe(false);
    expect(await privateUrlRejected(browser(), "http://10.0.0.20:11434/v1")).toBeNull();
  });

  it("stays strict with requireLogin off", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    expect(await blocksPrivateUrls(browser())).toBe(true);
    expect(await privateUrlRejected(browser(), "http://10.0.0.20:11434/v1")).toBe(PRIVATE_URL_ERROR);
  });

  it("stays strict on an unclaimed instance", async () => {
    mocks.needsSetup.mockResolvedValue(true);
    expect(await blocksPrivateUrls(browser())).toBe(true);
  });

  it("stays strict without a session, or with a restricted one", async () => {
    expect(await blocksPrivateUrls(browser(null))).toBe(true);
    mocks.getDashboardAuthSession.mockImplementation(async (token) => (token ? { authenticated: true, pwChange: true } : null));
    expect(await blocksPrivateUrls(browser())).toBe(true);
  });

  it("keeps the management API's internal requests strict", async () => {
    expect(await blocksPrivateUrls(managementInternal())).toBe(true);
    expect(mocks.getDashboardAuthSession).toHaveBeenCalledWith(undefined);
  });

  it("is strict for every remote caller without the variable", async () => {
    vi.unstubAllEnvs();
    expect(await blocksPrivateUrls(browser())).toBe(true);
  });
});
