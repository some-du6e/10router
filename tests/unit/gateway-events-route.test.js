// The Go gateway hands Node the writes Node makes itself through
// /api/internal/gateway/events (src/lib/gatewayEvents.ts): learned beta flags
// go through chat.ts's saveDroppedBetas. Only a request from this machine
// with the gateway's token gets in; everything else is a 404.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const saveDroppedBetas = vi.fn(async () => {});
const getProviderConnectionById = vi.fn();
const isLocalRequest = vi.fn(() => true);
vi.mock("@/sse/handlers/chat.js", () => ({ saveDroppedBetas }));
vi.mock("@/lib/db/index.js", () => ({ getProviderConnectionById }));
vi.mock("@/dashboardGuard.js", () => ({ isLocalRequest }));

const { handleGatewayEvent, GATEWAY_EVENTS_TOKEN_HEADER, GATEWAY_EVENTS_PATH, VERIFY_GATEWAY_TOKEN } = await import("../../src/lib/gatewayEvents.ts");
const { POST } = await import("../../src/app/api/internal/gateway/events/route.ts");

const TOKEN = "g".repeat(64);
const verifyToken = (t) => t === TOKEN;
const CONN = { id: "k1", provider: "openai-compatible-chat-hot", providerSpecificData: { baseUrl: "https://gateway.example.test/v1", ownBaseUrl: true } };
const event = { type: "betas-learned", connectionId: "k1", provider: "openai-compatible-chat-hot", droppedBetas: ["flag-a", "flag-b"] };

function request(body, token = TOKEN) {
  const headers = { "content-type": "application/json" };
  if (token) headers[GATEWAY_EVENTS_TOKEN_HEADER] = token;
  return new Request("http://127.0.0.1:20129/api/internal/gateway/events", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function deps(over = {}) {
  return {
    isLocalRequest: () => true,
    verifyToken,
    getConnection: async (id) => (id === "k1" ? CONN : null),
    saveDroppedBetas,
    ...over,
  };
}

beforeEach(() => {
  saveDroppedBetas.mockClear();
  getProviderConnectionById.mockReset();
  isLocalRequest.mockReset();
  isLocalRequest.mockReturnValue(true);
});

describe("gateway events", () => {
  // The Go client (gateway/internal/nodeevents) and this route are one
  // contract in two languages: the path, the token header, the event's
  // fields and the 204 it waits for.
  it("is the route the Go client posts to, with the fields it sends", () => {
    const go = readFileSync(new URL("../../gateway/internal/nodeevents/nodeevents.go", import.meta.url), "utf8");
    const constant = (name) => go.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1];
    expect(constant("Path")).toBe(GATEWAY_EVENTS_PATH);
    expect(constant("TokenHeader")?.toLowerCase()).toBe(GATEWAY_EVENTS_TOKEN_HEADER);
    expect(existsSync(new URL(`../../src/app${GATEWAY_EVENTS_PATH}/route.ts`, import.meta.url))).toBe(true);
    for (const field of Object.keys(event)) expect(go, field).toContain(`"${field}"`);
    expect(go).toContain(`"type": "betas-learned"`);
    expect(go).toContain("http.StatusNoContent");
  });

  it("writes learned beta flags through saveDroppedBetas with the stored connection", async () => {
    const res = await handleGatewayEvent(request(event), deps());
    expect(res.status).toBe(204);
    expect(saveDroppedBetas).toHaveBeenCalledTimes(1);
    expect(saveDroppedBetas).toHaveBeenCalledWith({ connectionId: "k1", providerSpecificData: CONN.providerSpecificData }, "openai-compatible-chat-hot", ["flag-a", "flag-b"]);
  });

  it("is a 404 unless the gateway sent it from this machine", async () => {
    for (const [name, req, d] of [
      ["not behind the gateway", request(event), deps({ verifyToken: undefined })],
      ["not from this machine", request(event), deps({ isLocalRequest: () => false })],
      ["no token", request(event, ""), deps()],
      ["another token", request(event, "h".repeat(64)), deps()],
    ]) {
      const res = await handleGatewayEvent(req, d);
      expect(res.status, name).toBe(404);
    }
    expect(saveDroppedBetas).not.toHaveBeenCalled();
  });

  it("hands saveDroppedBetas the flags as sent: it keeps only flag names itself", async () => {
    const res = await handleGatewayEvent(request({ ...event, droppedBetas: ["flag-a", " flag b "] }), deps());
    expect(res.status).toBe(204);
    expect(saveDroppedBetas.mock.calls[0][2]).toEqual(["flag-a", " flag b "]);
  });

  it("refuses events it doesn't know, and flags that aren't strings", async () => {
    const bad = [
      "{",
      [],
      { ...event, type: "other" },
      { ...event, connectionId: "" },
      { ...event, provider: 5 },
      { ...event, droppedBetas: [] },
      { ...event, droppedBetas: "flag-a" },
      { ...event, droppedBetas: [7] },
      { ...event, droppedBetas: ["x".repeat(257)] },
      { ...event, droppedBetas: Array.from({ length: 201 }, (_, i) => `f${i}`) },
    ];
    for (const body of bad) {
      const res = await handleGatewayEvent(request(body), deps());
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(saveDroppedBetas).not.toHaveBeenCalled();
  });

  it("is a 404 for a connection that isn't there or is another provider's", async () => {
    expect((await handleGatewayEvent(request({ ...event, connectionId: "k9" }), deps())).status).toBe(404);
    expect((await handleGatewayEvent(request({ ...event, provider: "openai-compatible-chat-cold" }), deps())).status).toBe(404);
    expect(saveDroppedBetas).not.toHaveBeenCalled();
  });

  it("the route wires the guard, the stored row and saveDroppedBetas", async () => {
    getProviderConnectionById.mockResolvedValue(CONN);
    expect((await POST(request(event))).status).toBe(404);
    globalThis[VERIFY_GATEWAY_TOKEN] = verifyToken;
    try {
      expect((await POST(request(event))).status).toBe(204);
      expect(getProviderConnectionById).toHaveBeenCalledWith("k1");
      expect(saveDroppedBetas).toHaveBeenCalledWith({ connectionId: "k1", providerSpecificData: CONN.providerSpecificData }, "openai-compatible-chat-hot", ["flag-a", "flag-b"]);
      isLocalRequest.mockReturnValue(false);
      expect((await POST(request(event))).status).toBe(404);
    } finally {
      delete globalThis[VERIFY_GATEWAY_TOKEN];
    }
  });
});
