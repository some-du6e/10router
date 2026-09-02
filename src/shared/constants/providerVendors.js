// Vendor grouping + ranking for the Providers page "By vendor" view.
//
// The registry lists one entry per *endpoint*, so a single vendor can appear
// half a dozen times (OpenAI is codex + openai + azure; Google is eight
// entries). That is accurate but unreadable — the grid becomes 100+ flat cards
// and the same logo shows up in three different sections because Codex is
// OAuth while the OpenAI API is an API key.
//
// VENDORS collapses those endpoints onto one card. RANK_SCORES orders the grid
// by how capable each provider actually is rather than alphabetically.
//
// MAINTENANCE: both tables are keyed by registry id and hand-maintained. A new
// registry entry that belongs to an existing vendor must be added to its
// `routes` or it renders as its own card, and anything missing from
// RANK_SCORES falls back to DEFAULT_SCORE and sorts to the bottom.
// `tests/unit/provider-vendors.test.js` fails on ids that no longer exist.

// Peak model score per lab, Artificial Analysis Intelligence Index v4.1.1.
// Shown as a small badge on the vendor card. Refresh when the index moves.
export const AAII_INDEX_VERSION = "v4.1.1";
export const AAII_SCORES = {
  anthropic: { score: 63, model: "Claude Opus 5" },
  openai: { score: 61, model: "GPT-5.6 Sol" },
  xai: { score: 61, model: "Grok 4.6" },
  moonshot: { score: 60, model: "Kimi K3" },
  zai: { score: 60, model: "GLM-5.3" },
};

// One entry per vendor. `routes` is [registryId, shortLabel] in display order;
// the first three fit on the card and the rest go behind a "+N" expander, so
// list the endpoint people reach for first.
export const VENDORS = [
  { id: "openai", name: "OpenAI", icon: "openai", color: "#000000", routes: [["codex", "Codex"], ["openai", "API"], ["azure", "Azure"]] },
  { id: "anthropic", name: "Anthropic", icon: "anthropic", color: "#D97757", routes: [["claude", "Claude Code"], ["anthropic", "API"]] },
  { id: "google", name: "Google", icon: "gemini", color: "#4285F4", routes: [["gemini-cli", "Gemini CLI"], ["gemini", "API"], ["vertex", "Vertex"], ["antigravity", "Antigravity"], ["vertex-partner", "Partner"], ["nanobanana", "NanoBanana"], ["google-tts", "TTS"], ["google-pse", "Search"]] },
  { id: "xai", name: "xAI", icon: "xai", color: "#000000", routes: [["grok-cli", "Grok CLI"], ["xai", "API"], ["grok-web", "Web"]] },
  { id: "zai", name: "Z.ai / GLM", icon: "glm", color: "#3B82F6", routes: [["glm", "Coding Plan"], ["glm-cn", "API (CN)"]] },
  { id: "moonshot", name: "Moonshot", icon: "kimi", color: "#000000", routes: [["kimi", "Kimi"], ["kimchi", "Kimchi"]] },
  { id: "minimax", name: "MiniMax", icon: "minimax", color: "#F23F5D", routes: [["minimax", "Coding"], ["minimax-cn", "API (CN)"]] },
  { id: "alibaba", name: "Alibaba / Qwen", icon: "alicode-intl", color: "#615CED", routes: [["alicode-intl", "Coding"], ["alicode", "Coding (CN)"], ["alims-intl", "Studio"]] },
  { id: "amazon", name: "Amazon", icon: "kiro", color: "#FF9900", routes: [["kiro", "Kiro"], ["aws-polly", "Polly"]] },
  { id: "microsoft", name: "Microsoft", icon: "github", color: "#000000", routes: [["github", "Copilot"], ["edge-tts", "Edge TTS"]] },
  { id: "bytedance", name: "ByteDance", icon: "byteplus", color: "#325AB4", routes: [["byteplus", "BytePlus"], ["volcengine-ark", "Ark"]] },
  { id: "perplexity", name: "Perplexity", icon: "perplexity", color: "#20808D", routes: [["perplexity", "API"], ["perplexity-agent", "Agent"], ["perplexity-web", "Web"]] },
  { id: "xiaomi", name: "Xiaomi MiMo", icon: "xiaomi-mimo", color: "#FF6900", routes: [["xiaomi-mimo", "API"], ["xiaomi-tokenplan", "Token Plan"]] },
  { id: "ollama", name: "Ollama", icon: "ollama", color: "#000000", routes: [["ollama", "Cloud"], ["ollama-local", "Local"]] },
  { id: "opencode", name: "OpenCode", icon: "opencode", color: "#000000", routes: [["opencode", "Free"], ["opencode-go", "Go"]] },
  { id: "cline", name: "Cline", icon: "cline", color: "#4B5563", routes: [["cline", "OAuth"], ["clinepass", "ClinePass"]] },
  { id: "codebuddy", name: "CodeBuddy", icon: "codebuddy-intl", color: "#4F46E5", routes: [["codebuddy-intl", "Intl"], ["codebuddy-cn", "CN"]] },
  { id: "kilo", name: "Kilo", icon: "kilocode", color: "#F59E0B", routes: [["kilocode", "Kilo Code"], ["kilo-gateway", "Gateway"]] },
];

// Higher sorts first. Frontier labs lead, ordered by AAII_SCORES; IDE and
// subscription resellers are scored by the models they actually serve (Cursor
// fronts Claude Opus and GPT Codex, so it outranks an open-weights-only host);
// secondary endpoints of a vendor sit low because the card already ranks by its
// best route.
export const DEFAULT_SCORE = 12;
export const RANK_SCORES = {
  claude: 100, anthropic: 99,
  codex: 98, openai: 97,
  "grok-cli": 96, xai: 95,
  kimi: 94,
  glm: 93,
  gemini: 92, "gemini-cli": 91, deepseek: 90, "alicode-intl": 89,
  minimax: 88, mistral: 87, github: 86, kiro: 85, vertex: 84, azure: 83,
  antigravity: 82, cohere: 76, nvidia: 75,
  openrouter: 74, cursor: 73, blackbox: 72, "opencode": 71, groq: 70,
  cerebras: 69, qoder: 68, together: 67, commandcode: 66, kilocode: 65,
  "vercel-ai-gateway": 64, cline: 63, nebius: 62, hyperbolic: 61,
  siliconflow: 60, chutes: 59, "cloudflare-ai": 58, huggingface: 57,
  featherless: 55, venice: 54, tokenrouter: 53, byteplus: 52,
  "volcengine-ark": 51, "vertex-partner": 50, ollama: 49, perplexity: 48,
  clinepass: 47, "opencode-go": 46, "kilo-gateway": 45, "codebuddy-intl": 45,
  "glm-cn": 44, "codebuddy-cn": 44, "minimax-cn": 43, alicode: 42,
  "alims-intl": 41, baidu: 40, tencent: 39, kimchi: 38, "xiaomi-mimo": 37,
  "xiaomi-tokenplan": 36, poolside: 35, morph: 34, llm7: 33, "grok-web": 32,
  "perplexity-web": 31, "perplexity-agent": 30,
  "api-airforce": 22, bazaarlink: 21,
  // Self-hosted / local: useful but not ranked against hosted frontier models.
  "ollama-local": 20, sdwebui: 20, comfyui: 20, searxng: 20, "local-device": 20,
  "selfhosted-stt": 20, "selfhosted-tts": 20, "selfhosted-embedding": 20,
  "edge-tts": 20,
};

// registryId -> vendor, for "is this endpoint already on a vendor card?"
export const VENDOR_BY_ROUTE = Object.fromEntries(
  VENDORS.flatMap((v) => v.routes.map(([id]) => [id, v])),
);

export const rankScore = (id) => RANK_SCORES[id] ?? DEFAULT_SCORE;

// A vendor card ranks by its strongest endpoint.
export const vendorRankScore = (vendor) =>
  Math.max(...vendor.routes.map(([id]) => rankScore(id)));
