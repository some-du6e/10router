"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { keyStatus, pickFields } from "@/lib/cliTools/statusFields.js";
import { isKeepExistingKey } from "@/lib/cliTools/keepKey.js";
import { checkNewBaseUrl, isCredential } from "@/lib/cliTools/keepKeyTarget.js";
import { writePrivateFile } from "@/lib/cliTools/privateFile.js";

const execAsync = promisify(exec);

// The env vars the status shows: base URL, context cap and the model mappings.
const STATUS_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  ...Object.values(CLI_TOOLS.claude.envVars),
  ...CLI_TOOLS.claude.defaultModels.map((m) => m.envKey).filter(Boolean),
];

// The env keys the card writes (base URL, key, model mappings, context cap). Any
// other key is refused: HTTPS_PROXY or NODE_TLS_REJECT_UNAUTHORIZED would reroute
// the key, NODE_OPTIONS would run code on this host.
const WRITABLE_ENV_KEYS = new Set([...STATUS_ENV_KEYS, "ANTHROPIC_AUTH_TOKEN", "API_TIMEOUT_MS"]);

// Credentials in settings.json the card never writes, which Claude Code would send
// to whatever base URL the request sets: named in the error so the user can fix it.
function otherStoredCredentials(settings) {
  const env = settings?.env || {};
  return [
    env.ANTHROPIC_API_KEY ? "env.ANTHROPIC_API_KEY" : null,
    env.ANTHROPIC_CUSTOM_HEADERS ? "env.ANTHROPIC_CUSTOM_HEADERS" : null,
    settings?.apiKeyHelper ? "apiKeyHelper" : null,
  ].filter(Boolean);
}

// Exa MCP def — reuse from coworkPlugins (DRY).
const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa");
const buildExaMcpEntry = () => ({
  type: EXA_PLUGIN.transport,
  url: EXA_PLUGIN.url,
});

// Get claude settings path based on OS
const getClaudeSettingsPath = () => {
  const homeDir = os.homedir();
  return path.join(homeDir, ".claude", "settings.json");
};

// Claude Code CLI reads mcpServers from ~/.claude.json (NOT settings.json).
const getClaudeJsonPath = () => path.join(os.homedir(), ".claude.json");

const readClaudeJson = async () => {
  try {
    const content = await fs.readFile(getClaudeJsonPath(), "utf-8");
    return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

const writeClaudeJsonMcp = async (mcpServers) => {
  const filePath = getClaudeJsonPath();
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    data.mcpServers = { ...(data.mcpServers || {}), ...mcpServers };
  } else if (data.mcpServers) {
    delete data.mcpServers.exa;
    if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers;
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
};


// Check if claude CLI is installed (via which/where or config file exists)
const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings
const readSettings = async () => {
  try {
    const settingsPath = getClaudeSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const has10Router = !!(settings?.env?.ANTHROPIC_BASE_URL);
    const claudeJson = await readClaudeJson();
    const env = settings?.env || {};

    return NextResponse.json({
      installed: true,
      // settings.json can hold any env var (other tokens, proxies): only the ones the card reads.
      settings: settings ? { env: pickFields(env, STATUS_ENV_KEYS) } : null,
      // Never the token itself: whether one is set, and which of our keys it is.
      authToken: await keyStatus(env.ANTHROPIC_AUTH_TOKEN),
      has10Router: has10Router,
      exaMcpEnabled: !!claudeJson?.mcpServers?.exa,
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json(
      { error: "Failed to check claude settings" },
      { status: 500 }
    );
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const { env, exaMcpEnabled, maxContextTokens } = await request.json();
    
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      return NextResponse.json(
        { error: "Invalid env object" },
        { status: 400 }
      );
    }
    const refused = Object.keys(env).filter((key) => !WRITABLE_ENV_KEYS.has(key));
    if (refused.length) {
      return NextResponse.json({ error: `These env keys can't be set here: ${refused.join(", ")}` }, { status: 400 });
    }
    if (Object.values(env).some((value) => typeof value !== "string" && typeof value !== "number")) {
      return NextResponse.json({ error: "Env values must be strings or numbers" }, { status: 400 });
    }
    if (env.ANTHROPIC_BASE_URL !== undefined && typeof env.ANTHROPIC_BASE_URL !== "string") {
      return NextResponse.json({ error: "ANTHROPIC_BASE_URL must be a string" }, { status: 400 });
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.endsWith("/v1") 
        ? env.ANTHROPIC_BASE_URL 
        : `${env.ANTHROPIC_BASE_URL}/v1`;
    }

    // The card couldn't show the stored token (a custom key): keep it as it is. A
    // body without a token (or with an empty one) keeps it too, through the env
    // merge below.
    const storedEnv = currentSettings.env || {};
    if (isKeepExistingKey(env.ANTHROPIC_AUTH_TOKEN)) {
      if (!storedEnv.ANTHROPIC_AUTH_TOKEN) {
        return NextResponse.json({ error: "No existing API key to keep; choose a key" }, { status: 400 });
      }
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    if (env.ANTHROPIC_AUTH_TOKEN === "") delete env.ANTHROPIC_AUTH_TOKEN;
    // Any other token must be a real one, whatever the base URL: a blank or
    // numeric token leaves Claude Code on its own login, which would then go to
    // the stored base URL.
    if (env.ANTHROPIC_AUTH_TOKEN !== undefined && !isCredential(env.ANTHROPIC_AUTH_TOKEN)) {
      return NextResponse.json({ error: "ANTHROPIC_AUTH_TOKEN must be a non-blank string; choose a key" }, { status: 400 });
    }

    // The base URL settings.json ends up with (empty: Anthropic's own API) must be
    // the stored one or this instance, or come with a token chosen for it (without
    // one, Claude Code sends the stored token, or signs in with its own claude.ai or
    // Console login), and with no other stored credential that would go along.
    const effectiveBaseUrl = env.ANTHROPIC_BASE_URL !== undefined ? env.ANTHROPIC_BASE_URL : storedEnv.ANTHROPIC_BASE_URL;
    if (effectiveBaseUrl) {
      const target = await checkNewBaseUrl({
        tool: "Claude Code",
        baseUrl: effectiveBaseUrl,
        storedBaseUrl: storedEnv.ANTHROPIC_BASE_URL,
        credential: env.ANTHROPIC_AUTH_TOKEN,
        fallback: storedEnv.ANTHROPIC_AUTH_TOKEN ? "the stored ANTHROPIC_AUTH_TOKEN" : "its own Claude login",
        otherCredentials: otherStoredCredentials(currentSettings),
        where: "settings.json",
      });
      if (target.error) return NextResponse.json({ error: target.error }, { status: 400 });
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };

    // CLAUDE_CODE_MAX_CONTEXT_TOKENS — only set when a concrete value is chosen;
    // "Default" removes the key so Claude Code falls back to the model's window.
    if (maxContextTokens) {
      newSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(maxContextTokens);
    } else {
      delete newSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    }

    // Write new settings (owner-only: it holds the key)
    await writePrivateFile(settingsPath, JSON.stringify(newSettings, null, 2));

    // Exa MCP toggle — write to ~/.claude.json (CLI reads mcpServers from here).
    if (EXA_PLUGIN) {
      await writeClaudeJsonMcp(exaMcpEnabled ? { exa: buildExaMcpEntry() } : null);
    }

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json(
      { error: "Failed to update claude settings" },
      { status: 500 }
    );
  }
}

// Fields to remove when resetting
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });
      
      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }

    // Remove injected MCP servers (Exa) from ~/.claude.json
    await writeClaudeJsonMcp(null);

    // Write updated settings
    await writePrivateFile(settingsPath, JSON.stringify(currentSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    return NextResponse.json(
      { error: "Failed to reset claude settings" },
      { status: 500 }
    );
  }
}
