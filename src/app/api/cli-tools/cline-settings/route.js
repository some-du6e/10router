"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { writePrivateFile } from "@/lib/cliTools/privateFile.js";
import { checkNewBaseUrl } from "@/lib/cliTools/keepKeyTarget.js";

const execAsync = promisify(exec);

const getDataDir = () => path.join(os.homedir(), ".cline", "data");
const getGlobalStatePath = () => path.join(getDataDir(), "globalState.json");
const getSecretsPath = () => path.join(getDataDir(), "secrets.json");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where cline" : "which cline";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getGlobalStatePath());
      return true;
    } catch {
      return false;
    }
  }
};

const readJson = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

const has10RouterConfig = (globalState) => {
  if (!globalState) return false;
  const isOpenAi =
    globalState.actModeApiProvider === "openai" || globalState.planModeApiProvider === "openai";
  const baseUrl = globalState.openAiBaseUrl || "";
  return isOpenAi && (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("10router"));
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Cline CLI is not installed" });
    }
    const globalState = await readJson(getGlobalStatePath());
    return NextResponse.json({
      installed: true,
      settings: {
        actModeApiProvider: globalState?.actModeApiProvider,
        planModeApiProvider: globalState?.planModeApiProvider,
        openAiBaseUrl: globalState?.openAiBaseUrl,
        openAiModelId: globalState?.openAiModelId,
      },
      has10Router: has10RouterConfig(globalState),
      globalStatePath: getGlobalStatePath(),
    });
  } catch (error) {
    console.log("Error checking cline settings:", error);
    return NextResponse.json({ error: "Failed to check cline settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (typeof baseUrl !== "string" || !baseUrl.trim() || !apiKey || !model) {
      return NextResponse.json({ error: "baseUrl, apiKey and model are required" }, { status: 400 });
    }

    await fs.mkdir(getDataDir(), { recursive: true });

    // Cline expects base WITHOUT /v1
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;

    const globalState = (await readJson(getGlobalStatePath())) || {};

    // Cline sends openAiHeaders (which can carry a token) with every OpenAI-provider
    // request, and this route leaves them in place.
    const storedHeaders = globalState.openAiHeaders;
    const target = await checkNewBaseUrl({
      tool: "Cline",
      baseUrl: normalizedBaseUrl,
      storedBaseUrl: globalState.openAiBaseUrl,
      otherCredentials: storedHeaders && Object.keys(storedHeaders).length ? ["openAiHeaders"] : [],
      where: "globalState.json",
    });
    if (target.error) return NextResponse.json({ error: target.error }, { status: 400 });

    globalState.actModeApiProvider = "openai";
    globalState.planModeApiProvider = "openai";
    globalState.openAiBaseUrl = normalizedBaseUrl;
    globalState.openAiModelId = model;
    globalState.planModeOpenAiModelId = model;
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    const secrets = (await readJson(getSecretsPath())) || {};
    secrets.openAiApiKey = apiKey;
    await writePrivateFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    return NextResponse.json({ success: true, message: "Cline settings applied successfully!", globalStatePath: getGlobalStatePath() });
  } catch (error) {
    console.log("Error updating cline settings:", error);
    return NextResponse.json({ error: "Failed to update cline settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const globalState = await readJson(getGlobalStatePath());
    if (!globalState) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }

    if (globalState.actModeApiProvider === "openai") {
      delete globalState.openAiBaseUrl;
      delete globalState.openAiModelId;
      delete globalState.planModeOpenAiModelId;
      globalState.actModeApiProvider = "cline";
      globalState.planModeApiProvider = "cline";
    }
    await fs.writeFile(getGlobalStatePath(), JSON.stringify(globalState, null, 2));

    const secrets = (await readJson(getSecretsPath())) || {};
    delete secrets.openAiApiKey;
    await writePrivateFile(getSecretsPath(), JSON.stringify(secrets, null, 2));

    return NextResponse.json({ success: true, message: "10router settings removed from Cline" });
  } catch (error) {
    console.log("Error resetting cline settings:", error);
    return NextResponse.json({ error: "Failed to reset cline settings" }, { status: 500 });
  }
}
