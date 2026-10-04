import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
}));

vi.mock("node:http2", () => ({
  connect: connectMock,
  default: { connect: connectMock },
}));

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

const originalFetch = global.fetch;

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

function makeEmitter() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const listeners = handlers.get(event) || [];
      listeners.push(handler);
      handlers.set(event, listeners);
      return this;
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) || []) handler(...args);
    },
  };
}

function mockCatalog(id, name, status = 200) {
  const client = makeEmitter();
  const request = makeEmitter();
  client.request = vi.fn(() => request);
  client.close = vi.fn();
  request.end = vi.fn(() => {
    request.emit("response", { ":status": status });
    request.emit("data", Buffer.from(model(id, name)));
    request.emit("end");
  });
  connectMock.mockReturnValueOnce(client);
  return { client, request };
}

const credentials = {
  accessToken: "cursor-token",
  providerSpecificData: { machineId: "machine-id" },
};

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    connectMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    clearCursorModelCache();
    connectMock.mockReset();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const { client } = mockCatalog("claude-4.6-opus", "Claude 4.6 Opus");

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledOnce();
    expect(connectMock).toHaveBeenCalledWith("https://agent.api5.cursor.sh");
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      accept: "application/proto",
      "content-type": "application/proto",
      authorization: "Bearer cursor-token",
      "x-cursor-checksum": expect.stringMatching(/machine-id$/),
    }));
  });

  it.each([
    ["access token", { ...credentials, accessToken: "other-token" }],
    ["machine ID", { ...credentials, providerSpecificData: { machineId: "other-machine" } }],
  ])("isolates cached catalogs by %s", async (_label, otherCredentials) => {
    mockCatalog("account-a-model", "Account A");
    mockCatalog("account-b-model", "Account B");

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "account-a-model", name: "Account A" }],
    });
    await expect(resolveCursorModels(otherCredentials)).resolves.toEqual({
      models: [{ id: "account-b-model", name: "Account B" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "account-a-model", name: "Account A" }],
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes expired catalogs while reusing a fresh catalog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    mockCatalog("old-model", "Old catalog");
    mockCatalog("new-model", "New catalog");

    const first = await resolveCursorModels(credentials);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    await expect(resolveCursorModels(credentials)).resolves.toEqual(first);
    expect(connectMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "new-model", name: "New catalog" }],
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh replaces even a fresh cached catalog", async () => {
    mockCatalog("old-model", "Old catalog");
    mockCatalog("new-model", "New catalog");
    await resolveCursorModels(credentials);

    const refreshed = { models: [{ id: "new-model", name: "New catalog" }] };
    await expect(resolveCursorModels(credentials, { forceRefresh: true })).resolves.toEqual(refreshed);
    await expect(resolveCursorModels(credentials)).resolves.toEqual(refreshed);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429, 500])("fails open for HTTP %s even with a valid catalog body", async (status) => {
    // A parseable body ensures status validation, rather than a decoder error, rejects it.
    const { client, request } = mockCatalog("error-model", "Must not be accepted", status);
    const warn = vi.fn();

    await expect(resolveCursorModels(credentials, { log: { warn } })).resolves.toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
    expect(request.end).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("CURSOR_MODELS", `Live model fetch failed: Cursor GetUsableModels returned ${status}`);
  });
});
