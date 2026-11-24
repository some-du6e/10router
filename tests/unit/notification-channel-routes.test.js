import { describe, it, expect, vi, beforeEach } from "vitest";

const caller = vi.hoisted(() => ({ local: false, session: false }));
const state = vi.hoisted(() => ({ channels: [] }));
const json = vi.hoisted(() => vi.fn((body, init) => ({ status: init?.status || 200, body })));

vi.mock("next/server", () => ({ NextResponse: { json } }));
vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: () => caller.local,
  hasSignedInDashboardSession: async () => caller.session,
}));
vi.mock("@/shared/services/quotaNotifications", () => ({ configureQuotaNotifications: vi.fn() }));
vi.mock("@/lib/db/index.js", () => ({
  getNotificationChannels: vi.fn(async () => state.channels),
  getNotificationChannelById: vi.fn(async (id) => state.channels.find((c) => c.id === id) || null),
  createNotificationChannel: vi.fn(async (input) => {
    const channel = { id: `n${state.channels.length + 1}`, ...input };
    state.channels.push(channel);
    return channel;
  }),
  updateNotificationChannel: vi.fn(async (id, input) => {
    const channel = state.channels.find((c) => c.id === id);
    Object.assign(channel, input);
    return channel;
  }),
  deleteNotificationChannel: vi.fn(),
}));

const channels = await import("../../src/app/api/notifications/channels/route.js");
const channel = await import("../../src/app/api/notifications/channels/[id]/route.js");
const { PRIVATE_NETWORK_NOT_ALLOWED } = await import("../../src/lib/notifications/validation.js");

const req = (body) => ({ url: "http://gw.example/api/notifications/channels", json: async () => body, headers: new Headers() });
const params = (id) => ({ params: Promise.resolve({ id }) });
const LAN_NTFY = { name: "LAN ntfy", type: "ntfy", config: { serverUrl: "http://10.0.0.4", topic: "t", allowPrivateNetwork: true } };

beforeEach(() => {
  caller.local = false;
  caller.session = false;
  state.channels = [];
  vi.unstubAllEnvs();
});

describe("notification channel routes", () => {
  it("a remote session can't create or switch on private network delivery", async () => {
    const created = await channels.POST(req(LAN_NTFY));
    expect(created.status).toBe(400);
    expect(created.body.error).toBe(PRIVATE_NETWORK_NOT_ALLOWED);
    expect(state.channels).toHaveLength(0);

    caller.local = true;
    expect((await channels.POST(req({ ...LAN_NTFY, config: { ...LAN_NTFY.config, allowPrivateNetwork: false } }))).status).toBe(201);
    caller.local = false;
    const switched = await channel.PUT(req(LAN_NTFY), params("n1"));
    expect(switched.status).toBe(400);
    expect(state.channels[0].config.allowPrivateNetwork).toBe(false);
  });

  it("follows ALLOW_PRIVATE_ENDPOINT_URLS for signed-in sessions, and local callers are free", async () => {
    caller.session = true;
    vi.stubEnv("ALLOW_PRIVATE_ENDPOINT_URLS", "true");
    expect((await channels.POST(req(LAN_NTFY))).status).toBe(201);
    vi.unstubAllEnvs();
    // Already on for that host: a remote rename passes.
    expect((await channel.PUT(req({ ...LAN_NTFY, name: "renamed" }), params("n1"))).status).toBe(200);
    caller.session = false;
    caller.local = true;
    expect((await channels.POST(req(LAN_NTFY))).status).toBe(201);
  });
});
