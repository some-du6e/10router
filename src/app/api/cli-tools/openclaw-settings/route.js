"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { keyStatus, pickFields } from "@/lib/cliTools/statusFields.js";
import { isKeepExistingKey } from "@/lib/cliTools/keepKey.js";
import { mayKeepStoredKey, CHOOSE_A_KEY_ERROR } from "@/lib/cliTools/keepKeyTarget.js";
import { writePrivateFile } from "@/lib/cliTools/privateFile.js";

const execAsync = promisify(exec);

// OpenClaw 2026.5.x writes agents[].model as either a plain string
// (legacy) or as an object `{ primary, fallbacks }`. Normalize to the
// string id so downstream consumers can call `.startsWith()` safely.
const resolveAgentModel = (m) => {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.primary ?? "";
  return "";
};

const getOpenClawDir = () => path.join(os.homedir(), ".openclaw");
const getOpenClawSettingsPath = () => path.join(getOpenClawDir(), "openclaw.json");

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where openclaw" : "which openclaw";
    // On Windows, inject %APPDATA%\npm into PATH so npm global packages are found
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getOpenClawSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    const settingsPath = getOpenClawSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// Check if settings has 10router config
const has10RouterConfig = (settings) => {
  if (!settings || !settings.models || !settings.models.providers) return false;
  return !!settings.models.providers["10router"];
};

// Read per-agent models.json and return current model id (without "10router/" prefix)
const readAgentModel = async (agentDir) => {
  try {
    const modelsPath = path.join(agentDir, "models.json");
    const content = await fs.readFile(modelsPath, "utf-8");
    const data = JSON.parse(content);
    const models = data?.providers?.["10router"]?.models;
    return models?.[0]?.id || null;
  } catch {
    return null;
  }
};

// The parts of openclaw.json the card and the CLI menu read: this router's provider
// (base URL, first model id, and whether its key is set and which of our keys it
// is, never the key) and the default model. Other providers carry their own keys,
// and this status reaches remote dashboard sessions.
const summarizeSettings = async (settings) => {
  if (!settings) return null;
  const providers = {};
  for (const name of ["10router", "9router"]) {
    const provider = settings.models?.providers?.[name];
    if (!provider || typeof provider !== "object") continue;
    const firstModel = Array.isArray(provider.models) ? provider.models[0]?.id : null;
    providers[name] = {
      ...pickFields(provider, ["baseUrl"]),
      ...(typeof firstModel === "string" ? { models: [{ id: firstModel }] } : {}),
      apiKeyStatus: await keyStatus(provider.apiKey),
    };
  }
  const primary = settings.agents?.defaults?.model?.primary;
  return {
    models: { providers },
    agents: { defaults: { model: typeof primary === "string" ? { primary } : {} } },
  };
};

// GET - Check openclaw CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenClawInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Open Claw CLI is not installed",
      });
    }

    const settings = await readSettings();

    // Enrich agents list with current per-agent model from models.json.
    // Coerce agent.model to its string id when OpenClaw stores it as
    // `{ primary, fallbacks }` so downstream `.startsWith()` calls work.
    const agentList = settings?.agents?.list || [];
    const enrichedAgents = await Promise.all(
      agentList.map(async (agent) => {
        const agentModel = agent.agentDir ? await readAgentModel(agent.agentDir) : null;
        return { ...pickFields(agent, ["id", "name", "agentDir"]), model: resolveAgentModel(agent.model), currentModel: agentModel };
      })
    );

    return NextResponse.json({
      installed: true,
      settings: await summarizeSettings(settings),
      agents: enrichedAgents,
      has10Router: has10RouterConfig(settings),
      settingsPath: getOpenClawSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking openclaw settings:", error);
    return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 });
  }
}

// Write per-agent models.json
const writeAgentModels = async (agentDir, model, baseUrl, apiKey) => {
  await fs.mkdir(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, "models.json");
  let existing = {};
  try {
    const content = await fs.readFile(modelsPath, "utf-8");
    existing = JSON.parse(content);
  } catch { /* No existing */ }

  if (!existing.providers) existing.providers = {};
  existing.providers["10router"] = {
    baseUrl,
    apiKey: apiKey || "your_api_key",
    api: "openai-completions",
    models: [{ id: model, name: model.split("/").pop() || model }],
  };
  await writePrivateFile(modelsPath, JSON.stringify(existing, null, 2));
};

// POST - Update 10router settings (merge with existing settings)
export async function POST(request) {
  try {
    // agentModels: { [agentId]: modelId } for per-agent override
    const { baseUrl, model, agentModels = {}, apiKey: requestedKey } = await request.json();
    let apiKey = requestedKey;
    
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();

    await fs.mkdir(openclawDir, { recursive: true });

    let settings = {};
    try {
      const existingSettings = await fs.readFile(settingsPath, "utf-8");
      settings = JSON.parse(existingSettings);
    } catch { /* No existing settings */ }

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    if (!settings.agents.defaults.model) settings.agents.defaults.model = {};
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const fullModelId = `10router/${model}`;

    // The card couldn't show the stored key (a custom one): keep it, but only
    // while it still goes to the same base URL or to this instance.
    if (isKeepExistingKey(apiKey)) {
      const stored = settings.models.providers["10router"]?.apiKey
        ? settings.models.providers["10router"]
        : settings.models.providers["9router"];
      apiKey = stored?.apiKey;
      if (!apiKey) return NextResponse.json({ error: "No existing API key to keep; choose a key" }, { status: 400 });
      if (!(await mayKeepStoredKey(normalizedBaseUrl, stored?.baseUrl))) {
        return NextResponse.json({ error: CHOOSE_A_KEY_ERROR }, { status: 400 });
      }
    }

    // Remove all old 10router/* entries from agents.defaults.models
    Object.keys(settings.agents.defaults.models)
      .filter((k) => k.startsWith("10router/"))
      .forEach((k) => { delete settings.agents.defaults.models[k]; });

    // Update default model
    settings.agents.defaults.model.primary = fullModelId;

    // Collect all unique models (default + per-agent)
    const allModelIds = new Set([model]);
    Object.values(agentModels).forEach((m) => { if (m) allModelIds.add(m); });

    // Add fresh 10router models to allowlist
    allModelIds.forEach((m) => {
      settings.agents.defaults.models[`10router/${m}`] = {};
    });

    // Remove old 10router model from each agent in agents.list. The
    // model field may be a plain string or `{ primary, fallbacks }`.
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        if (resolveAgentModel(agent.model).startsWith("10router/")) {
          const { model: _, ...rest } = agent;
          return rest;
        }
        return agent;
      });
    }

    // Update models.providers.10router with all models
    settings.models.providers["10router"] = {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || "your_api_key",
      api: "openai-completions",
      models: [...allModelIds].map((m) => ({ id: m, name: m.split("/").pop() || m })),
    };

    // Set per-agent model in agents.list and write models.json
    if (settings.agents.list) {
      settings.agents.list = settings.agents.list.map((agent) => {
        const agentModel = agentModels[agent.id];
        if (agentModel) return { ...agent, model: `10router/${agentModel}` };
        return agent;
      });

      // Write per-agent models.json for agents with agentDir
      await Promise.all(
        settings.agents.list.map(async (agent) => {
          if (!agent.agentDir) return;
          const agentModel = agentModels[agent.id];
          const modelToWrite = agentModel || model; // fallback to default
          await writeAgentModels(agent.agentDir, modelToWrite, normalizedBaseUrl, apiKey);
        })
      );
    }

    await writePrivateFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    console.log("Error updating openclaw settings:", error);
    return NextResponse.json({ error: "Failed to update openclaw settings" }, { status: 500 });
  }
}

// DELETE - Remove 10router settings only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getOpenClawSettingsPath();

    // Read existing settings
    let settings = {};
    try {
      const existingSettings = await fs.readFile(settingsPath, "utf-8");
      settings = JSON.parse(existingSettings);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    // Remove 10router from models.providers
    if (settings.models && settings.models.providers) {
      delete settings.models.providers["10router"];
      
      // Remove providers object if empty
      if (Object.keys(settings.models.providers).length === 0) {
        delete settings.models.providers;
      }
    }

    // Remove 10router models from agents.defaults.models allowlist
    if (settings.agents?.defaults?.models) {
      const keysToRemove = Object.keys(settings.agents.defaults.models).filter((k) => k.startsWith("10router/"));
      for (const key of keysToRemove) {
        delete settings.agents.defaults.models[key];
      }
      if (Object.keys(settings.agents.defaults.models).length === 0) {
        delete settings.agents.defaults.models;
      }
    }

    // Reset agents.defaults.model.primary if it uses 10router
    if (settings.agents?.defaults?.model?.primary?.startsWith("10router/")) {
      delete settings.agents.defaults.model.primary;
    }

    // Write updated settings
    await writePrivateFile(settingsPath, JSON.stringify(settings, null, 2));

    return NextResponse.json({
      success: true,
      message: "10router settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting openclaw settings:", error);
    return NextResponse.json({ error: "Failed to reset openclaw settings" }, { status: 500 });
  }
}
