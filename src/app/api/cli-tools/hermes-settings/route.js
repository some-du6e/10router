"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { findUnsafeConfigValue, unsafeConfigValueError } from "@/lib/cliTools/configValue.js";
import { writePrivateFile } from "@/lib/cliTools/privateFile.js";
import { checkNewBaseUrl } from "@/lib/cliTools/keepKeyTarget.js";

const execAsync = promisify(exec);

const PROVIDER_NAME = "10router";
const API_KEY_ENV = "OPENAI_API_KEY";

const getHermesDir = () => path.join(os.homedir(), ".hermes");
const getHermesConfigPath = () => path.join(getHermesDir(), "config.yaml");
const getHermesEnvPath = () => path.join(getHermesDir(), ".env");

// Match top-level "model:" block (until next non-indented, non-empty line)
const MODEL_BLOCK_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

const API_KEY_REF = `\${${API_KEY_ENV}}`;

// apiKey null: the block reads the key from .env through ${OPENAI_API_KEY}.
// Otherwise it carries the key itself (checked by findUnsafeConfigValue).
const buildModelBlock = (model, baseUrl, apiKey = null) =>
  `model:\n  default: "${model}"\n  provider: "custom"\n  base_url: "${baseUrl}"\n  api_key: ${apiKey ? `"${apiKey}"` : API_KEY_REF}\n`;

// Parse current model block back to fields (best-effort, simple key:value)
const parseModelBlock = (yaml) => {
  const match = yaml.match(MODEL_BLOCK_RE);
  if (!match) return null;
  const body = match[1] || "";
  const get = (key) => {
    const m = body.match(new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, "m"));
    return m ? m[1].trim() : null;
  };
  return {
    default: get("default"),
    provider: get("provider"),
    base_url: get("base_url"),
    api_key: get("api_key"),
  };
};

const upsertModelBlock = (yaml, newBlock) => {
  if (MODEL_BLOCK_RE.test(yaml)) return yaml.replace(MODEL_BLOCK_RE, newBlock);
  return yaml.length > 0 ? `${newBlock}\n${yaml}` : newBlock;
};

const removeModelBlock = (yaml) => yaml.replace(MODEL_BLOCK_RE, "").replace(/^\n+/, "");

// .env helpers — upsert/remove single KEY=VALUE line
const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n${line}\n` : `${envText}${line}\n`;
};

const removeEnvVar = (envText, key) => {
  const re = new RegExp(`^${key}=.*\\r?\\n?`, "m");
  return envText.replace(re, "");
};

const checkHermesInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where hermes" : "which hermes";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getHermesConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfigYaml = async () => {
  try {
    return await fs.readFile(getHermesConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const readEnvFile = async () => {
  try {
    return await fs.readFile(getHermesEnvPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

// Detect 10router by base_url containing localhost/127.0.0.1 or matching tunnel URL
const has10RouterConfig = (modelCfg) => {
  if (!modelCfg?.base_url) return false;
  return modelCfg.provider === "custom" && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(modelCfg.base_url);
};

export async function GET() {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Hermes Agent is not installed" });
    }
    const yaml = await readConfigYaml();
    const model = parseModelBlock(yaml);
    // Without api_key: the model block's key may be any provider's.
    const { api_key: _apiKey, ...shownModel } = model || {};
    return NextResponse.json({
      installed: true,
      settings: { model: model ? shownModel : null },
      has10Router: has10RouterConfig(model),
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    console.log("Error checking hermes settings:", error);
    return NextResponse.json({ error: "Failed to check hermes settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }
    const unsafeField = findUnsafeConfigValue({ baseUrl, apiKey, model });
    if (unsafeField) {
      return NextResponse.json({ error: unsafeConfigValueError(unsafeField) }, { status: 400 });
    }

    const dir = getHermesDir();
    await fs.mkdir(dir, { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    // The block reads OPENAI_API_KEY from ~/.hermes/.env, which can be the user's
    // own key. It may keep doing so only for this instance, or for the base URL
    // the stored block already sent that key to. Anywhere else the request's key
    // goes into the block itself, and .env is left alone. For a custom base_url
    // Hermes takes model.api_key (with ${VAR} expanded) ahead of any env key
    // (hermes_cli/runtime_provider_backends.py, _resolve_openrouter_runtime).
    const existingYaml = await readConfigYaml();
    const stored = parseModelBlock(existingYaml);
    const target = await checkNewBaseUrl({
      tool: "Hermes",
      baseUrl: normalizedBaseUrl,
      storedBaseUrl: stored?.api_key === API_KEY_REF ? stored.base_url : null,
      credential: apiKey,
      fallback: `${API_KEY_ENV} from ~/.hermes/.env`,
    });
    if (target.error) return NextResponse.json({ error: target.error }, { status: 400 });

    // Update config.yaml — replace/insert model: block, keep everything else.
    // Owner-only: the block can hold a key.
    const newYaml = upsertModelBlock(existingYaml, buildModelBlock(model, normalizedBaseUrl, target.foreign ? apiKey : null));
    await writePrivateFile(getHermesConfigPath(), newYaml);

    // Update .env — upsert OPENAI_API_KEY when the caller provides one and the
    // block reads it from there (this instance or the stored base URL); a foreign
    // host's key is in the block, and .env stays as it was.
    if (apiKey && !target.foreign) {
      const existingEnv = await readEnvFile();
      const newEnv = upsertEnvVar(existingEnv, API_KEY_ENV, apiKey);
      await writePrivateFile(getHermesEnvPath(), newEnv);
    }

    return NextResponse.json({
      success: true,
      message: "Hermes settings applied successfully!",
      configPath: getHermesConfigPath(),
    });
  } catch (error) {
    console.log("Error updating hermes settings:", error);
    return NextResponse.json({ error: "Failed to update hermes settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getHermesConfigPath();
    let yaml = "";
    try {
      yaml = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ success: true, message: "No config file to reset" });
      }
      throw error;
    }
    const newYaml = removeModelBlock(yaml);
    await fs.writeFile(configPath, newYaml);
    return NextResponse.json({ success: true, message: `${PROVIDER_NAME} model block removed` });
  } catch (error) {
    console.log("Error resetting hermes settings:", error);
    return NextResponse.json({ error: "Failed to reset hermes settings" }, { status: 500 });
  }
}
