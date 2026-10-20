// onBetasRejected persistence (PR #89 review): merge only droppedBetas into a
// fresh read of the connection/node, and don't lose flags to concurrent writes.
import { describe, it, expect, vi } from "vitest";

const { mocks, db, tick } = vi.hoisted(() => ({
  mocks: {
    getProviderCredentials: vi.fn(), markAccountUnavailable: vi.fn(), clearAccountError: vi.fn(),
    getModelInfo: vi.fn(), getComboModels: vi.fn(), handleChatCore: vi.fn(),
  },
  db: { conns: {}, nodes: {} },
  tick: () => new Promise((r) => setTimeout(r, 5)),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(() => true),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({})),
  getProviderConnectionById: vi.fn(async (id) => structuredClone(db.conns[id])),
  updateProviderConnection: vi.fn(async (id, data) => { await tick(); db.conns[id] = { ...db.conns[id], ...data }; return db.conns[id]; }),
  getProviderNodeById: vi.fn(async (id) => structuredClone(db.nodes[id])),
  updateProviderNode: vi.fn(async (id, data) => { await tick(); db.nodes[id] = { ...db.nodes[id], ...data }; return db.nodes[id]; }),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
  comboLookupName: (model) => model,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  handleComboChat: (await importOriginal()).handleComboChat,
  handleFusionChat: (await importOriginal()).handleFusionChat,
  detectRequiredCapabilities: vi.fn(() => new Set()),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  maskKey: vi.fn((key) => key),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/sse/services/claudeBuiltinSearch.js", () => ({
  enrichClaudeBuiltinSearch: vi.fn(async (body) => body),
}));

const { saveDroppedBetas } = await import("../../src/sse/handlers/chat.js");

describe("saveDroppedBetas", () => {
  it("keeps settings changed since the request started and unions concurrent flags", async () => {
    db.conns.c1 = { id: "c1", providerSpecificData: { baseUrl: "https://x/v1", modelRoutes: { a: "anthropic" } } };
    db.nodes.n1 = { id: "n1", droppedBetas: ["old-1"] };
    // Snapshot from request start: no modelRoutes yet.
    const stale = () => ({ connectionId: "c1", providerSpecificData: { baseUrl: "https://x/v1" } });
    await Promise.all([
      saveDroppedBetas(stale(), "n1", ["a-1"]),
      saveDroppedBetas(stale(), "n1", ["b-2"]),
    ]);
    expect(db.conns.c1.providerSpecificData.modelRoutes).toEqual({ a: "anthropic" });
    expect(db.conns.c1.providerSpecificData.droppedBetas.sort()).toEqual(["a-1", "b-2"]);
    expect(db.nodes.n1.droppedBetas.sort()).toEqual(["a-1", "b-2", "old-1"]);
  });
});

describe("saveDroppedBetas sanitizing", () => {
  it("drops malformed flags and caps the list at 50", async () => {
    db.conns.c2 = { id: "c2", providerSpecificData: {} };
    db.nodes.n2 = { id: "n2" };
    const many = Array.from({ length: 60 }, (_, i) => `flag-${i}`);
    await saveDroppedBetas({ connectionId: "c2", providerSpecificData: {} }, "n2", ["bad flag!", ...many]);
    expect(db.nodes.n2.droppedBetas).toHaveLength(50);
    expect(db.nodes.n2.droppedBetas).not.toContain("bad flag!");
    expect(db.conns.c2.providerSpecificData.droppedBetas).toHaveLength(50);
  });
});

describe("saveDroppedBetas on a key with its own endpoint", () => {
  it("keeps the learned flags on that key only", async () => {
    db.conns.c3 = { id: "c3", providerSpecificData: { baseUrl: "https://other/v1", ownBaseUrl: true } };
    db.nodes.n3 = { id: "n3", droppedBetas: ["node-1"] };
    await saveDroppedBetas({ connectionId: "c3", providerSpecificData: { baseUrl: "https://other/v1", ownBaseUrl: true } }, "n3", ["own-1"]);
    expect(db.conns.c3.providerSpecificData.droppedBetas).toEqual(["own-1"]);
    expect(db.nodes.n3.droppedBetas).toEqual(["node-1"]);
  });
});
