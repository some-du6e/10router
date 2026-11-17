"use server";

import { NextResponse } from "next/server";
import { findUnsafeConfigValue } from "@/lib/cliTools/configValue.js";
import { keyStatus, pickFields } from "@/lib/cliTools/statusFields.js";
import { isKeepExistingKey } from "@/lib/cliTools/keepKey.js";
import { mayKeepStoredKey, CHOOSE_A_KEY_ERROR } from "@/lib/cliTools/keepKeyTarget.js";
import { writePrivateFile } from "@/lib/cliTools/privateFile.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";

const execAsync = promisify(exec);

const getJcodeConfigDir = () => path.join(os.homedir(), ".jcode");
const getConfigPath = () => path.join(getJcodeConfigDir(), "config.toml");

const getProviderEnvPath = () => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", "provider-10router.env");
};

const checkJcodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where jcode" : "which jcode";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getJcodeConfigDir());
      return true;
    } catch {
      return false;
    }
  }
};

const readConfig = async () => {
  try {
    const configPath = getConfigPath();
    const content = await fs.readFile(configPath, "utf-8");
    return parseTOML(content);
  } catch (error) {
    return { providers: {} };
  }
};

const has10RouterConfig = (config) => {
  if (!config || !config.providers) return false;

  const providers = config.providers;

  if (providers["10router"]) return true;

  for (const [name, provider] of Object.entries(providers)) {
    if (provider.base_url && provider.base_url.includes("localhost:20128")) {
      return true;
    }
  }

  return false;
};

const writeConfig = async (config) => {
  const configPath = getConfigPath();
  const content = stringifyTOML(config);
  await fs.writeFile(configPath, content, "utf-8");
};

const readProviderEnv = async () => {
  try {
    const envPath = getProviderEnvPath();
    const content = await fs.readFile(envPath, "utf-8");
    const env = {};

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        env[key] = value;
      }
    }

    return env;
  } catch {
    return {};
  }
};

const writeProviderEnv = async (env) => {
  const envPath = getProviderEnvPath();
  let content = "# jcode provider environment variables\n";

  for (const [key, value] of Object.entries(env)) {
    content += `${key}="${value}"\n`;
  }

  // Owner-only: it holds the client key.
  await writePrivateFile(envPath, content);
};

export async function GET() {
  const isInstalled = await checkJcodeInstalled();

  if (!isInstalled) {
    return NextResponse.json({
      installed: false,
      message: "jcode not installed. Install via: curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash",
    });
  }

  const config = await readConfig();
  const has10Router = has10RouterConfig(config);

  // Only this router's provider URL and model: config.toml can hold other
  // providers' keys and headers, and this status reaches remote dashboard sessions.
  const providers = {};
  for (const name of ["10router", "9router"]) {
    const provider = config?.providers?.[name];
    if (provider && typeof provider === "object") providers[name] = pickFields(provider, ["base_url", "default_model"]);
  }

  // The key lives in the provider env file: whether it is set, and which of our
  // keys it is, never the key itself.
  const providerEnv = await readProviderEnv();

  return NextResponse.json({
    installed: true,
    config: { providers },
    apiKeyStatus: await keyStatus(providerEnv.JCODE_10ROUTER_API_KEY),
    has10Router,
    configPath: getConfigPath(),
  });
}

export async function POST(request) {
  try {
    const { baseUrl, models, apiKey: requestedKey } = await request.json();
    // The card couldn't show the stored key (a custom one): keep it, but only
    // while it still goes to the same base URL or to this instance.
    const keep = isKeepExistingKey(requestedKey);
    const apiKey = keep ? (await readProviderEnv()).JCODE_10ROUTER_API_KEY : requestedKey;

    if (!baseUrl || !apiKey) {
      return NextResponse.json(
        { error: keep ? "No existing API key to keep; choose a key" : "baseUrl and apiKey are required" },
        { status: 400 }
      );
    }
    if (keep) {
      const stored = await readConfig();
      const storedBaseUrl = stored?.providers?.["10router"]?.base_url ?? stored?.providers?.["9router"]?.base_url;
      if (!(await mayKeepStoredKey(baseUrl, storedBaseUrl))) {
        return NextResponse.json({ error: CHOOSE_A_KEY_ERROR }, { status: 400 });
      }
    }
    const unsafeField = findUnsafeConfigValue({ baseUrl, apiKey });
    if (unsafeField) {
      return NextResponse.json({ error: `Invalid ${unsafeField}` }, { status: 400 });
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;

    let config = await readConfig();

    if (!config.providers) {
      config.providers = {};
    }

    config.providers["10router"] = {
      type: "openai-compatible",
      base_url: normalizedBaseUrl,
      auth: "bearer",
      api_key_env: "JCODE_10ROUTER_API_KEY",
      env_file: "provider-10router.env",
      default_model: models && models.length > 0 ? models[0] : "cc/claude-opus-4-7",
      requires_api_key: true,
    };

    const configDir = getJcodeConfigDir();
    await fs.mkdir(configDir, { recursive: true });

    await writeConfig(config);

    const xdgConfigDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const jcodeConfigDir = path.join(xdgConfigDir, "jcode");
    await fs.mkdir(jcodeConfigDir, { recursive: true });

    const env = await readProviderEnv();
    env.JCODE_10ROUTER_API_KEY = apiKey;
    await writeProviderEnv(env);

    return NextResponse.json({
      success: true,
      message: "jcode configured successfully. Use: jcode --provider-profile 10router",
      configPath: getConfigPath(),
    });
  } catch (error) {
    console.error("Error configuring jcode:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const config = await readConfig();

    if (!config.providers) {
      return NextResponse.json({ success: true, message: "No configuration to remove" });
    }

    delete config.providers["10router"];

    await writeConfig(config);

    const env = await readProviderEnv();
    delete env.JCODE_10ROUTER_API_KEY;
    await writeProviderEnv(env);

    return NextResponse.json({
      success: true,
      message: "10router configuration removed from jcode",
    });
  } catch (error) {
    console.error("Error removing jcode configuration:", error);
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
