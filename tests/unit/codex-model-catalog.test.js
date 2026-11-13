// GET /backend-api/codex/models must decode as Codex's ModelsResponse, or
// Codex drops the whole catalog and runs every model it doesn't know on
// generic metadata, which has no apply_patch tool. The field rules below are
// Codex's ModelInfo (codex-rs/protocol/src/openai_models.rs) at rust-v0.167.2
// and rust-v0.137.0; .github/workflows/codex-model-catalog.yml checks the same
// catalog against the real Codex binaries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-catalog-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;
delete global._dbAdapter;

const db = await import("@/lib/db/index.js");
const { getAdapter } = await import("@/lib/db/driver.js");
const { GET } = await import("@/app/api/v1/codex/models/route.js");
const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");
const { PROVIDER_ID_TO_ALIAS } = await import("@/shared/constants/models");
const {
  buildCodexCatalog, findCodexModel, toCodexEntry, codexModelsFor, codexShapeFor, uniqueBySlug,
  CODEX_BASE_INSTRUCTIONS, CODEX_BUNDLED_MODELS, CODEX_CATALOG_VERSION,
} = await import("@/lib/codex/modelCatalog.js");
const { resetRoutedModels } = await import("@/lib/codex/routedModels.js");

beforeAll(async () => {
  await getAdapter();
});

// The route caches the routed model list; these tests change it (combos, keys).
beforeEach(() => {
  resetRoutedModels();
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
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
    upgrade: optional((u) => isString(u.model) && isString(u.migration_markdown)),
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
  if (!isString(instructions) || instructions === "") errors.push(`${entry.slug}: no instructions`);
  return errors;
}

const catalog = async (version, headers) => {
  const query = version ? `?client_version=${version}` : "";
  return (await GET(new Request(`http://localhost/backend-api/codex/models${query}`, { headers }))).json();
};

const bundled = (slug) => CODEX_BUNDLED_MODELS.find((m) => m.slug === slug);
const isGeneric = (entry) => entry.base_instructions === CODEX_BASE_INSTRUCTIONS;

const ALIAS_TO_PROVIDER = Object.fromEntries(Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]));
const capsOf = (id) => {
  const slash = id.indexOf("/");
  return slash === -1
    ? getCapabilitiesForModel(null, id)
    : getCapabilitiesForModel(ALIAS_TO_PROVIDER[id.slice(0, slash)] || id.slice(0, slash), id.slice(slash + 1));
};

describe("Codex model catalog", () => {
  it.each(Object.keys(CODEX))("decodes, entry by entry, for Codex %s", async (version) => {
    const body = await catalog(version);
    expect(body.models.length).toBeGreaterThan(50);
    expect(body.models.flatMap((entry) => decodeErrors(entry, version))).toEqual([]);
    const slugs = body.models.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("decodes for the current Codex when no client_version is sent", async () => {
    const body = await catalog();
    expect(body.models.flatMap((entry) => decodeErrors(entry, "0.167.2"))).toEqual([]);
  });

  it("gives every model that can call tools a shell and the freeform apply_patch tool", async () => {
    const body = await catalog("0.167.2");
    const generic = body.models.filter(isGeneric);
    expect(generic.length).toBeGreaterThan(50);
    for (const entry of generic) {
      const tools = capsOf(entry.slug).tools !== false;
      expect([entry.slug, entry.shell_type, entry.apply_patch_tool_type, entry.supports_parallel_tool_calls])
        .toEqual([entry.slug, tools ? "shell_command" : "disabled", tools ? "freeform" : null, tools]);
    }
    // Not only reasoning models: a plain chat model that calls tools gets them too.
    const plain = generic.find((entry) => capsOf(entry.slug).reasoning !== true && capsOf(entry.slug).tools !== false);
    expect(plain).toBeTruthy();
    expect(plain.supported_reasoning_levels).toEqual([]);
    expect(plain.apply_patch_tool_type).toBe("freeform");
  });

  it("gives models Codex has no metadata for Codex's own generic prompt, without the apps instructions", async () => {
    expect(CODEX_BASE_INSTRUCTIONS).toMatch(/^You are a coding agent running in the Codex CLI/);
    const body = await catalog("0.167.2");
    const claude = body.models.find((entry) => entry.slug.startsWith("cc/claude-"));
    expect(claude.base_instructions).toBe(CODEX_BASE_INSTRUCTIONS);
    expect(claude.include_apps_usage_instructions).toBe(false);
  });

  it("gives a model without tool calling no shell and no apply_patch", () => {
    const entry = toCodexEntry({ id: "acme/no-tools", owned_by: "acme", capabilities: { contextWindow: 8000, tools: false } });
    expect(entry.shell_type).toBe("disabled");
    expect(entry.apply_patch_tool_type).toBeNull();
    expect(entry.supports_parallel_tool_calls).toBe(false);
    for (const version of Object.keys(CODEX)) expect(decodeErrors(entry, version)).toEqual([]);
  });

  it("keeps the OpenAI-shaped data list, without the prompts or the hidden models", async () => {
    const body = await catalog("0.167.2");
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(body.models.filter((m) => m.visibility === "list").map((m) => m.slug));
    expect(body.data[0]).toMatchObject({ object: "model", owned_by: "10router" });
    expect(JSON.stringify(body.data)).not.toContain("You are a coding agent");
  });
});

describe("Codex's own models", () => {
  it("serve a ChatGPT-backed model with Codex's bundled metadata, with no Codex account connected", async () => {
    const body = await catalog("0.167.2");
    const entry = body.models.find((m) => m.slug === "cx/gpt-5.5");
    expect(entry).toMatchObject({
      display_name: "cx/gpt-5.5",
      visibility: "list",
      model_messages: { instructions_template: bundled("gpt-5.5").model_messages.instructions_template },
      apply_patch_tool_type: "freeform",
    });
    // `-review` runs the same model; Codex itself matches it by prefix.
    expect(body.models.find((m) => m.slug === "cx/gpt-5.5-review")?.model_messages)
      .toEqual(bundled("gpt-5.5").model_messages);
  });

  it("serve GPT models from other providers with the same metadata", () => {
    const codexModels = codexModelsFor("0.167.2");
    const [gh, openai, other] = buildCodexCatalog(
      [{ id: "gh/gpt-5.5" }, { id: "openai/gpt-5.5-review" }, { id: "acme/claude-opus-5-5" }],
      codexModels,
    );
    expect(gh.model_messages).toEqual(bundled("gpt-5.5").model_messages);
    expect(openai.model_messages).toEqual(bundled("gpt-5.5").model_messages);
    expect(other.base_instructions).toBe(CODEX_BASE_INSTRUCTIONS);
  });

  it("list a routed match even when Codex hides the model it matches", () => {
    const hidden = CODEX_BUNDLED_MODELS.find((m) => m.visibility === "hide");
    expect(hidden).toBeTruthy();
    const [entry] = buildCodexCatalog([{ id: `acme/${hidden.slug}` }], codexModelsFor("0.167.2"));
    expect(entry.slug).toBe(`acme/${hidden.slug}`);
    expect(entry.visibility).toBe("list");
  });

  it("don't offer a routed match Codex's upgrade to a bare model on another provider", () => {
    expect(bundled("gpt-5.5").upgrade?.model).toBeTruthy();
    const [entry] = buildCodexCatalog([{ id: "gh/gpt-5.5" }], codexModelsFor("0.167.2"));
    expect(entry.upgrade).toBeNull();
  });

  it("stay in under their bare names, hidden from the picker", async () => {
    const body = await catalog("0.167.2");
    for (const slug of ["gpt-5.5", "codex-auto-review"]) {
      const entry = body.models.find((m) => m.slug === slug);
      expect(entry?.visibility, slug).toBe("hide");
    }
    expect(body.data.map((m) => m.id)).not.toContain("gpt-5.5");
  });

  it("are hidden from a key whose allowlist doesn't allow them", async () => {
    await db.createCombo({ name: "catalog-combo", models: ["openai/gpt-a", "anthropic/claude-x"] });
    const created = await db.createApiKey("catalog-allowlist", "machine-test-0001");
    await db.updateApiKey(created.id, { allowedModels: ["catalog-combo"] });
    const key = await db.getApiKeyById(created.id);
    const body = await catalog("0.167.2", { Authorization: `Bearer ${key.key}` });
    expect(body.models.map((m) => m.slug)).toEqual(["catalog-combo"]);
  });

  it("are left out for a Codex older than the model", () => {
    expect(bundled("gpt-6-astra").minimal_client_version).toBe("0.153.0");
    expect(codexModelsFor("0.152.9").map((m) => m.slug)).not.toContain("gpt-6-astra");
    expect(codexModelsFor("0.153.0").map((m) => m.slug)).toContain("gpt-6-astra");
  });

  const efforts = (version, slug) => codexModelsFor(version).find((m) => m.slug === slug).supported_reasoning_levels.map((l) => l.effort);

  it("keep every reasoning effort from Codex 0.138, which reads unknown efforts as custom ones", () => {
    expect(efforts("0.138.0", "codex-auto-review")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts("0.160.0", "gpt-6-astra")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it("keep only the efforts Codex 0.137 knows for 0.137", () => {
    expect(efforts("0.137.0", "codex-auto-review")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(codexModelsFor("0.137.0").find((m) => m.slug === "codex-auto-review").default_reasoning_level).toBe("medium");
  });

  // Codex before 0.147 drops the template when `[features] personality = false`
  // and runs on base_instructions alone.
  it("carry the prompt itself in base_instructions for Codex before 0.147", () => {
    expect(bundled("gpt-5.5").base_instructions).toBeUndefined();
    for (const version of ["0.137.0", "0.146.0", "0.146.9"]) {
      for (const entry of codexModelsFor(version)) {
        expect(entry.base_instructions, `${version} ${entry.slug}`).toBe(entry.model_messages.instructions_template);
        expect(entry.base_instructions.length, entry.slug).toBeGreaterThan(1000);
      }
    }
  });

  it("carry an empty base_instructions from Codex 0.147, which keeps the template", () => {
    expect(CODEX_BUNDLED_MODELS.every((m) => m.model_messages?.instructions_template)).toBe(true);
    for (const version of ["0.147.0", "0.167.2", "0.0.0", null]) {
      expect(codexModelsFor(version).every((m) => m.base_instructions === ""), String(version)).toBe(true);
    }
  });

  it("have no personality placeholder Codex would fill in, so the template text is the prompt as is", () => {
    for (const entry of CODEX_BUNDLED_MODELS) expect(entry.model_messages.instructions_template, entry.slug).not.toContain("{{ personality }}");
  });

  it("treat a source build's 0.0.0, a missing version and an unreadable one like the newest Codex", async () => {
    const newest = codexShapeFor("0.167.2");
    expect(newest.slugs).toEqual(CODEX_BUNDLED_MODELS.map((m) => m.slug));
    for (const version of ["0.0.0", null, "x1", "0.168.0"]) expect(codexShapeFor(version), String(version)).toEqual(newest);
    expect(codexModelsFor("0.0.0").map((m) => m.supported_reasoning_levels)).toEqual(CODEX_BUNDLED_MODELS.map((m) => m.supported_reasoning_levels));
    const body = await catalog("0.0.0");
    expect(body.models.find((m) => m.slug === "cx/gpt-6-astra")?.model_messages).toEqual(bundled("gpt-6-astra").model_messages);
  });

  it("match the way Codex's own lookup does", () => {
    const candidates = [{ slug: "gpt-5.5" }, { slug: "gpt-5" }, { slug: "gpt-5.3-codex" }];
    expect(findCodexModel("gpt-5.5", candidates)?.slug).toBe("gpt-5.5");
    expect(findCodexModel("gpt-5.4", candidates)?.slug).toBe("gpt-5");
    expect(findCodexModel("cx/gpt-5.5-review", candidates)?.slug).toBe("gpt-5.5");
    expect(findCodexModel("custom/gpt-5.3-codex", candidates)?.slug).toBe("gpt-5.3-codex");
    expect(findCodexModel("openrouter/openai/gpt-5.5", candidates)).toBeNull();
    expect(findCodexModel("my.ns/gpt-5.5", candidates)).toBeNull();
    expect(findCodexModel("acme/claude-opus-5-5", candidates)).toBeNull();
  });
});

describe("slugs", () => {
  it("drops repeated and empty slugs, keeping the first", () => {
    const entries = [{ slug: "a", n: 1 }, { slug: "" }, { slug: "  " }, {}, { slug: "a", n: 2 }, { slug: "b" }];
    expect(uniqueBySlug(entries)).toEqual([{ slug: "a", n: 1 }, { slug: "b" }]);
  });

  it("keeps a routed model over Codex's hidden model of the same name", async () => {
    await db.createCombo({ name: "codex-auto-review", models: ["openai/gpt-a"] });
    const body = await catalog("0.167.2");
    const matches = body.models.filter((m) => m.slug === "codex-auto-review");
    expect(matches.map((m) => m.visibility)).toEqual(["list"]);
    const slugs = body.models.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    await db.deleteCombo((await db.getComboByName("codex-auto-review")).id);
  });
});

describe("the vendored Codex files", () => {
  it("come from the Codex release CODEX_CATALOG_VERSION names", () => {
    const tag = `rust-v${CODEX_CATALOG_VERSION}`;
    const prompt = JSON.parse(fs.readFileSync(new URL("../../open-sse/config/codex/prompt.json", import.meta.url), "utf8"));
    expect(prompt.source).toContain(`/${tag}/`);
    const notices = fs.readFileSync(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
    expect(notices.match(/rust-v\d+\.\d+\.\d+/g)).toEqual([tag]);
    // No model in the catalog needs a newer Codex than the release it came from.
    const version = CODEX_CATALOG_VERSION.split(".").map(Number);
    for (const model of CODEX_BUNDLED_MODELS) {
      const minimal = (model.minimal_client_version || "0.0.0").split(".").map(Number);
      expect(minimal[0] * 1e6 + minimal[1] * 1e3 + minimal[2]).toBeLessThanOrEqual(version[0] * 1e6 + version[1] * 1e3 + version[2]);
    }
  });
});

describe("the routed model list the catalog is built from", () => {
  it("has no Codex account in this test", async () => {
    expect(await db.getProviderConnections()).toEqual([]);
    expect((await buildModelsList(["llm"])).some((m) => m.id === "cx/gpt-5.5")).toBe(true);
  });
});
