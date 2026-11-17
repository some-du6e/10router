"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import {
  applyGrokBuildConfig,
  GROK_SUBAGENT_TYPES,
  parseGrokBuildConfig,
  resetGrokBuildConfig,
} from "@/lib/grokBuildConfig";
import { pickFields } from "@/lib/cliTools/statusFields.js";
import { writePrivateFile } from "@/lib/cliTools/privateFile.js";
import { findUnsafeConfigValue } from "@/lib/cliTools/configValue.js";

const execAsync = promisify(exec);

const getGrokDir = () => path.join(os.homedir(), ".grok");
const getGrokConfigPath = () => path.join(getGrokDir(), "config.toml");
const getGrokBinPath = () => path.join(getGrokDir(), "bin", "grok");

const checkGrokInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    await execAsync(isWindows ? "where grok" : "which grok", { windowsHide: true });
    return true;
  } catch {
    for (const candidate of [getGrokBinPath(), getGrokConfigPath()]) {
      try {
        await fs.access(candidate);
        return true;
      } catch { /* try next */ }
    }
    return false;
  }
};

const readConfigToml = async () => {
  try {
    return await fs.readFile(getGrokConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const normalizeContextWindow = (value, model) => {
  const explicit = Number(value);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : null;
  const modelId = slash > 0 ? model.slice(slash + 1) : model;
  return getCapabilitiesForModel(provider, modelId).contextWindow;
};

const normalizeSubagentModels = (value) => {
  if (value === undefined) return undefined; // backwards-compatible callers leave current overrides untouched
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const type of GROK_SUBAGENT_TYPES) {
    const entry = value[type];
    const model = typeof entry === "string" ? entry.trim() : entry?.model?.trim();
    if (!model) continue; // blank means inherit the main model
    result[type] = {
      model,
      contextWindow: normalizeContextWindow(entry?.contextWindow, model),
    };
  }
  return result;
};

const has10RouterConfig = (settings) => Boolean(settings?.model?.base_url);

export async function GET() {
  try {
    const installed = await checkGrokInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Grok Build is not installed",
      });
    }

    const settings = parseGrokBuildConfig(await readConfigToml());
    // A model section's api_key (and its raw body, which holds it) stays on the host.
    const shownModel = (section) => (section ? pickFields(section, ["model", "base_url", "name", "api_backend", "context_window"]) : null);
    return NextResponse.json({
      installed: true,
      settings: {
        ...settings,
        model: shownModel(settings.model),
        subagentModels: Object.fromEntries(
          Object.entries(settings.subagentModels || {}).map(([type, section]) => [type, shownModel(section)])
        ),
      },
      has10Router: has10RouterConfig(settings),
      configPath: getGrokConfigPath(),
    });
  } catch (error) {
    console.log("Error checking grok-build settings:", error);
    return NextResponse.json({ error: "Failed to check grok-build settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, contextWindow, subagentModels } = await request.json();
    const selectedModel = typeof model === "string" ? model.trim() : "";
    if (!baseUrl || !selectedModel) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }
    const subagents = normalizeSubagentModels(subagentModels);
    const unsafeField = findUnsafeConfigValue({
      baseUrl,
      apiKey,
      model: selectedModel,
      ...Object.fromEntries(Object.entries(subagents || {}).map(([type, entry]) => [`subagentModels.${type}`, entry.model])),
    });
    if (unsafeField) {
      return NextResponse.json({ error: `Invalid ${unsafeField}` }, { status: 400 });
    }

    await fs.mkdir(getGrokDir(), { recursive: true });
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const toml = applyGrokBuildConfig(await readConfigToml(), {
      baseUrl: normalizedBaseUrl,
      apiKey: apiKey || "sk_10router",
      model: selectedModel,
      contextWindow: normalizeContextWindow(contextWindow, selectedModel),
      subagentModels: subagents,
    });
    await writePrivateFile(getGrokConfigPath(), toml);

    return NextResponse.json({
      success: true,
      message: "Grok Build settings applied successfully!",
      configPath: getGrokConfigPath(),
      modelSlot: "10router",
    });
  } catch (error) {
    console.log("Error updating grok-build settings:", error);
    return NextResponse.json({ error: "Failed to update grok-build settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getGrokConfigPath();
    let toml;
    try {
      toml = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }

    await writePrivateFile(configPath, resetGrokBuildConfig(toml));
    return NextResponse.json({
      success: true,
      message: "10router model slots removed from Grok Build",
    });
  } catch (error) {
    console.log("Error resetting grok-build settings:", error);
    return NextResponse.json({ error: "Failed to reset grok-build settings" }, { status: 500 });
  }
}
