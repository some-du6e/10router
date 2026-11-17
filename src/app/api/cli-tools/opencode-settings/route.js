"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { writePrivateFile } from "@/lib/cliTools/privateFile.js";
import { checkNewBaseUrl } from "@/lib/cliTools/keepKeyTarget.js";
import { findUnsafeConfigValue, listFields, unsafeConfigValueError } from "@/lib/cliTools/configValue.js";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    // opencode config files may use JSONC format (trailing commas, comments).
    // Strip trailing commas before parsing to avoid SyntaxError on valid JSONC.
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // If the config file exists but is unparseable (corrupted, exotic JSONC),
    // treat it as "no config" rather than throwing a 500 that the UI
    // misinterprets as "opencode not installed".
    return null;
  }
};

const has10RouterConfig = (config) => {
  if (!config?.provider) return false;
  return !!config.provider["10router"];
};

// The parts of opencode.json the card reads: the 10router (and legacy 9router)
// base URL and the explorer subagent model. Other providers' options hold their
// API keys, and this status reaches remote dashboard sessions.
const summarizeConfig = (config) => {
  if (!config) return null;
  const provider = {};
  for (const name of ["10router", "9router"]) {
    const baseURL = config.provider?.[name]?.options?.baseURL;
    if (typeof baseURL === "string") provider[name] = { options: { baseURL } };
  }
  const explorerModel = config.agent?.explorer?.model;
  return {
    provider,
    ...(typeof explorerModel === "string" ? { agent: { explorer: { model: explorerModel } } } : {}),
  };
};

const isNonEmpty = (value) => value != null && typeof value === "object" && Object.keys(value).length > 0;

// Where the 10router provider entry holds a credential that a POST keeps: its
// options' headers and queryParams, and the headers of each model it doesn't
// replace (replacedIds).
const keptCredentialEntries = (provider, replacedIds) => {
  const found = [];
  if (isNonEmpty(provider.options?.headers)) found.push("provider.10router.options.headers");
  if (isNonEmpty(provider.options?.queryParams)) found.push("provider.10router.options.queryParams");
  for (const [id, entry] of Object.entries(provider.models || {})) {
    if (!replacedIds.includes(id) && isNonEmpty(entry?.headers)) found.push(`provider.10router.models.${id}.headers`);
  }
  return found;
};

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const providerConfig = config?.provider?.["10router"];
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config: summarizeConfig(config),
      has10Router: has10RouterConfig(config),
      configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: config?.model?.startsWith("10router/") ? config.model.replace(/^10router\//, "") : null,
          baseURL: providerConfig?.options?.baseURL || null,
        },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply 10router as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (typeof baseUrl !== "string" || !baseUrl.trim() || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }
    // OpenCode substitutes {env:VAR} and {file:path} anywhere in opencode.json.
    const unsafeField = findUnsafeConfigValue({ baseUrl, apiKey, activeModel, subagentModel, ...listFields("models", modelsArray) });
    if (unsafeField) {
      return NextResponse.json({ error: unsafeConfigValueError(unsafeField) }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch { /* No existing config */ }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || "sk_10router";
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing 10router provider entry and its models
    const existingProvider = config.provider["10router"] || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };

    // The merge below keeps the entry's other options and the models it doesn't
    // replace, so their stored headers and query params (which can carry a token)
    // would go to a new host along with the key.
    const target = await checkNewBaseUrl({
      tool: "OpenCode",
      baseUrl: normalizedBaseUrl,
      storedBaseUrl: existingProvider.options?.baseURL,
      otherCredentials: keptCredentialEntries(existingProvider, modelsArray),
      where: "opencode.json",
    });
    if (target.error) return NextResponse.json({ error: target.error }, { status: 400 });

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Add or update entries for all requested models
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      existingProvider.models[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
    }

    // Save merged provider back
    config.provider["10router"] = existingProvider;

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `10router/${finalActive}`;
      }
    }

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `10router/${effectiveSubagentModel}`,
    };

    await writePrivateFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
    });
  } catch (error) {
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file found" });
      }
      throw error;
    }

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (config.model?.startsWith("10router/")) {
        config.model = "";
      }
    }

    await writePrivateFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove 10router provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const configPath = getConfigPath();

    let config = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }

    // If specific model provided, remove just that model
    if (modelToRemove && config.provider?.["10router"]?.models) {
      delete config.provider["10router"].models[modelToRemove];
      
      // If no models left, remove the provider
      if (Object.keys(config.provider["10router"].models).length === 0) {
        delete config.provider["10router"];
        if (config.model?.startsWith("10router/")) delete config.model;
      } else if (config.model === `10router/${modelToRemove}`) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(config.provider["10router"].models);
        config.model = `10router/${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove entire 10router provider
      if (config.provider) delete config.provider["10router"];
      if (config.model?.startsWith("10router/")) delete config.model;
    }

    // Remove subagent configuration
    if (config.agent?.explorer?.model?.startsWith("10router/")) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

    await writePrivateFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "10router settings removed from OpenCode",
    });
  } catch (error) {
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: 500 });
  }
}
