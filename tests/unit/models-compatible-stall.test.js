// A compatible endpoint whose /models answers headers and then never finishes
// its body must not hold up the model list (and with it Codex's catalog).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "models-compatible-stall-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const db = await import("@/lib/db/index.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");

beforeAll(async () => {
  await getAdapter();
  await db.createProviderConnection({
    provider: "openai-compatible-stall",
    authType: "apikey",
    name: "stall",
    apiKey: "k",
    isActive: true,
    providerSpecificData: { baseUrl: "http://127.0.0.1:9/v1" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("model list with a compatible endpoint whose body stalls", () => {
  it("gives up on the body after the 5-second fetch timeout", async () => {
    vi.stubGlobal("fetch", async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let done = false;
    const pending = buildModelsList(["llm"]).then((models) => { done = true; return models; });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const models = await pending;
    expect(models.some((m) => m.id.startsWith("openai-compatible-stall/"))).toBe(false);
  });
});
