// importDb wipes every table first. Without DATA_DIR that is the real install
// in ~/.9router, so refuse to run rather than erase someone's accounts.
if (!process.env.DATA_DIR) {
  console.error("seed-demo: set DATA_DIR to a throwaway directory. It wipes the database there.");
  process.exit(1);
}

// getDataDir() silently falls back to ~/.9router when DATA_DIR isn't writable
// or is a Unix path on Windows. Check where it actually resolved.
const { DATA_DIR } = await import("../src/lib/dataDir.js");
const path = await import("node:path");
if (path.resolve(DATA_DIR) !== path.resolve(process.env.DATA_DIR)) {
  console.error(`seed-demo: DATA_DIR resolved to ${DATA_DIR}, not ${process.env.DATA_DIR}. Refusing to wipe it.`);
  process.exit(1);
}

const { importDb } = await import("../src/lib/db/index.js");

const now = Date.now();
const iso = (hoursAgo = 0) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();

function connection({
  id,
  provider,
  authType,
  name,
  email,
  testStatus = "success",
  isActive = true,
  hoursAgo = 2,
  lastError,
  errorCode,
  providerSpecificData,
}) {
  return {
    id,
    provider,
    authType,
    name,
    email,
    priority: 1,
    isActive,
    testStatus,
    lastTested: iso(hoursAgo),
    lastUsedAt: iso(hoursAgo + 1),
    ...(lastError ? { lastError, lastErrorAt: iso(hoursAgo), errorCode } : {}),
    ...(providerSpecificData ? { providerSpecificData } : {}),
    createdAt: iso(240),
    updatedAt: iso(hoursAgo),
  };
}

const oauth = (id, provider, name, email, options = {}) => connection({
  id,
  provider,
  authType: "oauth",
  name,
  email,
  ...options,
});

const apiKey = (id, provider, name, options = {}) => connection({
  id,
  provider,
  authType: "apikey",
  name,
  ...options,
});

const providerConnections = [
  oauth("demo-claude", "claude", "Work Claude", "alex@northstar.dev", {
    providerSpecificData: { username: "alex-chen" },
  }),
  oauth("demo-codex", "codex", "OpenAI work account", "alex@northstar.dev", {
    providerSpecificData: { chatgptAccountId: "demo-workspace" },
  }),
  oauth("demo-cursor", "cursor", "Cursor Pro", "alex@northstar.dev"),
  oauth("demo-github", "github", "GitHub Copilot", "alex@northstar.dev", {
    providerSpecificData: { githubLogin: "alex-chen", githubName: "Alex Chen" },
  }),
  oauth("demo-antigravity", "antigravity", "Antigravity", "alex@northstar.dev"),
  oauth("demo-cline", "cline", "Cline", "alex@northstar.dev"),
  oauth("demo-kilo", "kilocode", "Kilo Code", "alex@northstar.dev"),
  oauth("demo-grok", "grok-cli", "Grok Build", "alex@northstar.dev", {
    testStatus: "error",
    lastError: "Upstream rate limit reached",
    errorCode: 429,
    hoursAgo: 0.5,
  }),
  connection({
    id: "demo-gemini-cli",
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI",
    email: "alex@northstar.dev",
  }),
  connection({
    id: "demo-kiro",
    provider: "kiro",
    authType: "oauth",
    name: "Kiro AI",
    email: "alex@northstar.dev",
  }),
  apiKey("demo-openrouter", "openrouter", "OpenRouter production", { hoursAgo: 1 }),
  apiKey("demo-openai", "openai", "OpenAI API", {
    providerSpecificData: { projectId: "proj_demo" },
  }),
  apiKey("demo-anthropic", "anthropic", "Anthropic API"),
  apiKey("demo-groq", "groq", "Groq burst pool"),
  apiKey("demo-mistral", "mistral", "Mistral fallback"),
  apiKey("demo-deepseek", "deepseek", "DeepSeek batch"),
  apiKey("demo-xai", "xai", "xAI API", { hoursAgo: 3 }),
  apiKey("demo-luma", "openai-compatible-luma", "Luma Gateway", {
    providerSpecificData: {
      baseUrl: "https://gateway.luma.demo/v1",
      prefix: "luma",
      apiType: "chat",
      nodeName: "Luma Gateway",
    },
  }),
];

await importDb({
  settings: {
    requireLogin: true,
    requireApiKey: false,
    tunnelDashboardAccess: true,
    enableTranslator: true,
    showSensitiveRequestDetails: false,
  },
  providerConnections,
  providerNodes: [
    {
      id: "openai-compatible-luma",
      type: "openai-compatible",
      name: "Luma Gateway",
      prefix: "luma",
      apiType: "chat",
      baseUrl: "https://gateway.luma.demo/v1",
    },
  ],
  apiKeys: [
    {
      id: "demo-api-key",
      key: "sk_10router_demo",
      name: "README demo key",
      machineId: "10router-demo-machine",
      isActive: true,
      createdAt: iso(240),
    },
  ],
  proxyPools: [
    {
      id: "demo-pool",
      name: "US East failover",
      urls: ["http://proxy-a.demo:8080", "http://proxy-b.demo:8080"],
      isActive: true,
      testStatus: "success",
    },
  ],
});

console.log(`Seeded ${providerConnections.length} provider connections in DATA_DIR=${process.env.DATA_DIR || "default"}`);
