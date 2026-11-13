// GET /backend-api/codex/models must decode as Codex's ModelsResponse, or
// Codex drops the whole catalog and runs every model it doesn't know on
// generic metadata, which has no apply_patch tool. The field rules below are
// Codex's ModelInfo (codex-rs/protocol/src/openai_models.rs) at rust-v0.167.2
// and rust-v0.137.0; .github/workflows/codex-model-catalog.yml checks the same
// catalog against the real Codex binaries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const upstreamMock = vi.hoisted(() => ({ models: [] }));
vi.mock("@/sse/services/codexUpstreamCatalog.js", () => ({
  getCodexUpstreamModels: vi.fn(async () => upstreamMock.models),
}));

const { GET } = await import("@/app/api/v1/codex/models/route.js");
const { buildCodexCatalog, findCodexModel, toCodexEntry, CODEX_BASE_INSTRUCTIONS } = await import("@/lib/codex/modelCatalog.js");
const { getCodexUpstreamModels } = await import("@/sse/services/codexUpstreamCatalog.js");

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  upstreamMock.models = [];
});

const isString = (v) => typeof v === "string";
const isBool = (v) => typeof v === "boolean";
const isInt32 = (v) => Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31;
const isNullish = (v) => v === undefined || v === null;
const oneOf = (...values) => (v) => values.includes(v);
const optional = (check) => (v) => isNullish(v) || check(v);
const arrayOf = (check) => (v) => Array.isArray(v) && v.every(check);

const CODEX = {
  "0.167.2": {
    shell: oneOf("unified_exec", "disabled", "default", "local", "shell_command"),
    effort: (v) => isString(v) && v !== "",
    modality: oneOf("text", "image", "audio"),
    required: {},
  },
  "0.137.0": {
    shell: oneOf("default", "local", "unified_exec", "disabled", "shell_command"),
    effort: oneOf("none", "minimal", "low", "medium", "high", "xhigh"),
    modality: oneOf("text", "image"),
    required: {
      base_instructions: isString,
      supports_reasoning_summaries: isBool,
      supports_parallel_tool_calls: isBool,
    },
  },
};

// Fields without a serde default must be present; the others, when present, must decode.
function decodeErrors(entry, version) {
  const v = CODEX[version];
  const levelOk = (l) => l && v.effort(l.effort) && isString(l.description);
  const required = {
    slug: (s) => isString(s) && s.trim() !== "",
    display_name: isString,
    supported_reasoning_levels: arrayOf(levelOk),
    shell_type: v.shell,
    visibility: oneOf("list", "hide", "none"),
    supported_in_api: isBool,
    priority: isInt32,
    support_verbosity: isBool,
    truncation_policy: (t) => t && oneOf("bytes", "tokens")(t.mode) && Number.isInteger(t.limit),
    experimental_supported_tools: arrayOf(isString),
    ...v.required,
  };
  const typed = {
    description: optional(isString),
    default_reasoning_level: optional(v.effort),
    default_verbosity: optional(oneOf("low", "medium", "high")),
    apply_patch_tool_type: optional(oneOf("freeform")),
    web_search_tool_type: optional(oneOf("text", "text_and_image")),
    input_modalities: optional(arrayOf(v.modality)),
    context_window: optional(Number.isInteger),
    availability_nux: optional((n) => isString(n.message)),
    upgrade: optional((u) => isString(u.id) && isString(u.migration_config_key)),
  };
  const errors = [];
  for (const [field, check] of Object.entries(required)) {
    if (!(field in entry) || !check(entry[field])) errors.push(`${entry.slug}: ${field} = ${JSON.stringify(entry[field])}`);
  }
  for (const [field, check] of Object.entries(typed)) {
    if (field in entry && !check(entry[field])) errors.push(`${entry.slug}: ${field} = ${JSON.stringify(entry[field])}`);
  }
  // 0.167 promotes base_instructions into model_messages.instructions_template
  // and refuses an entry that has neither.
  const instructions = entry.model_messages?.instructions_template ?? entry.base_instructions;
  if (!isString(instructions)) errors.push(`${entry.slug}: no base_instructions or model_messages.instructions_template`);
  return errors;
}

const catalog = async (url = "http://localhost/backend-api/codex/models?client_version=0.167.2") =>
  (await GET(new Request(url))).json();

// Shaped like an entry of the ChatGPT backend's Codex catalog.
const upstreamEntry = (slug, extra = {}) => ({
  slug,
  display_name: slug.toUpperCase(),
  description: "Upstream model",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [{ effort: "medium", description: "Medium" }, { effort: "high", description: "High" }],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 2,
  availability_nux: null,
  upgrade: null,
  base_instructions: "",
  model_messages: { instructions_template: `prompt for ${slug}` },
  supports_reasoning_summaries: true,
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: true,
  context_window: 272000,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  ...extra,
});

describe("Codex model catalog", () => {
  it("lists routed models in an entry shape every Codex version decodes", async () => {
    const body = await catalog();
    expect(body.models.length).toBeGreaterThan(50);
    for (const version of Object.keys(CODEX)) {
      expect(body.models.flatMap((entry) => decodeErrors(entry, version)), version).toEqual([]);
    }
    const slugs = body.models.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("gives tool-capable models the freeform apply_patch tool and a shell", async () => {
    const body = await catalog();
    const claude = body.models.find((entry) => entry.slug.startsWith("cc/claude-"));
    expect(claude).toBeTruthy();
    expect(claude.apply_patch_tool_type).toBe("freeform");
    expect(claude.shell_type).toBe("shell_command");
    expect(claude.supports_parallel_tool_calls).toBe(true);
  });

  it("gives models Codex has no prompt for Codex's own generic prompt, not an empty one", async () => {
    expect(CODEX_BASE_INSTRUCTIONS).toMatch(/^You are a coding agent running in the Codex CLI/);
    expect(CODEX_BASE_INSTRUCTIONS).toContain("apply_patch");
    const body = await catalog();
    expect(body.models.every((entry) => entry.base_instructions === CODEX_BASE_INSTRUCTIONS)).toBe(true);
  });

  it("gives a model without tool calling no shell and no apply_patch", () => {
    const entry = toCodexEntry({ id: "acme/no-tools", owned_by: "acme", capabilities: { contextWindow: 8000, tools: false } });
    expect(entry.shell_type).toBe("disabled");
    expect(entry.apply_patch_tool_type).toBeNull();
    expect(entry.supports_parallel_tool_calls).toBe(false);
    for (const version of Object.keys(CODEX)) expect(decodeErrors(entry, version)).toEqual([]);
  });

  it("keeps the OpenAI-shaped data list, without the prompts", async () => {
    const body = await catalog();
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(body.models.map((m) => m.slug));
    expect(body.data[0]).toMatchObject({ object: "model", owned_by: "10router" });
    expect(JSON.stringify(body.data)).not.toContain("You are a coding agent");
  });

  it("asks for the upstream catalog of the Codex version that is asking", async () => {
    await catalog("http://localhost/backend-api/codex/models?client_version=0.137.0");
    expect(getCodexUpstreamModels).toHaveBeenLastCalledWith("0.137.0");
  });
});

describe("Codex catalog with Codex's own catalog from a connected account", () => {
  it("serves a ChatGPT-backed model with its upstream metadata under the routed id", async () => {
    upstreamMock.models = [upstreamEntry("gpt-5.5")];
    const body = await catalog();
    const entry = body.models.find((m) => m.slug === "cx/gpt-5.5");
    expect(entry).toMatchObject({
      display_name: "cx/gpt-5.5",
      visibility: "list",
      model_messages: { instructions_template: "prompt for gpt-5.5" },
      web_search_tool_type: "text_and_image",
      support_verbosity: true,
    });
    // `-review` runs the same upstream model; Codex itself matches it by prefix.
    expect(body.models.find((m) => m.slug === "cx/gpt-5.5-review")?.model_messages?.instructions_template).toBe("prompt for gpt-5.5");
    const claude = body.models.find((m) => m.slug.startsWith("cc/claude-"));
    expect(claude.base_instructions).toBe(CODEX_BASE_INSTRUCTIONS);
    for (const version of Object.keys(CODEX)) {
      expect(body.models.flatMap((e) => decodeErrors(e, version)), version).toEqual([]);
    }
  });

  it("keeps Codex's own models under their bare names, hidden from the picker", async () => {
    upstreamMock.models = [upstreamEntry("gpt-5.5"), upstreamEntry("codex-auto-review", { visibility: "hide" })];
    const body = await catalog();
    const bare = body.models.filter((m) => m.slug === "gpt-5.5" || m.slug === "codex-auto-review");
    expect(bare.map((m) => [m.slug, m.visibility])).toEqual([["gpt-5.5", "hide"], ["codex-auto-review", "hide"]]);
    expect(bare[0].model_messages.instructions_template).toBe("prompt for gpt-5.5");
    expect(body.data.map((m) => m.id)).not.toContain("gpt-5.5");
    const slugs = body.models.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("matches models the way Codex's own lookup does", () => {
    const candidates = [{ slug: "gpt-5.5" }, { slug: "gpt-5" }, { slug: "gpt-5.3-codex" }];
    expect(findCodexModel("gpt-5.5", candidates)?.slug).toBe("gpt-5.5");
    expect(findCodexModel("gpt-5.4", candidates)?.slug).toBe("gpt-5");
    expect(findCodexModel("cx/gpt-5.5-review", candidates)?.slug).toBe("gpt-5.5");
    expect(findCodexModel("custom/gpt-5.3-codex", candidates)?.slug).toBe("gpt-5.3-codex");
    expect(findCodexModel("openrouter/openai/gpt-5.5", candidates)).toBeNull();
    expect(findCodexModel("my.ns/gpt-5.5", candidates)).toBeNull();
    expect(findCodexModel("acme/claude-opus-5-5", candidates)).toBeNull();
    expect(buildCodexCatalog([{ id: "acme/claude-opus-5-5" }], candidates)[0].apply_patch_tool_type).toBe("freeform");
  });
});
