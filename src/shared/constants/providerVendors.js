// Vendor grouping + ranking for the Providers page "By vendor" view.
//
// The registry lists one entry per *endpoint*, so a single vendor can appear
// half a dozen times (OpenAI is codex + openai + azure; Google is eight
// entries). That is accurate but unreadable — the grid becomes 100+ flat cards
// and the same logo shows up in three different sections because Codex is
// OAuth while the OpenAI API is an API key.
//
// VENDORS collapses those endpoints onto one card. RANK_ORDER is the order
// the cards appear in.
//
// MAINTENANCE: both tables are hand-maintained. A new registry entry that
// belongs to an existing vendor must be added to its `routes` or it renders as
// its own card, and a card missing from RANK_ORDER sorts after the ranked ones.
// `tests/unit/provider-vendors.test.js` fails on ids that no longer exist.

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

// The user's own ranking (2026-10-18, from the "Rank vendors" picker in
// mockups/provider-setup): labs, then gateways, coding tools, inference hosts.
// Keys are card ids: a vendor id for a grouped card, else the registry id.
// The second block is the "don't care" pile, by rough popularity.
export const RANK_ORDER = [
  "anthropic", "openai", "openrouter", "xai", "cursor", "opencode", "groq", "microsoft",
  "zai", "cerebras", "amazon", "deepseek", "moonshot", "vercel-ai-gateway", "tokenrouter", "cloudflare-ai",
  "nvidia", "cohere", "tencent", "google", "minimax", "bytedance", "perplexity", "alibaba",
  "xiaomi", "mistral",
  // "Don't care"
  "together", "fireworks", "ollama", "cline", "kilo", "chutes", "siliconflow", "nebius",
  "hyperbolic", "featherless", "venice", "baidu", "blackbox", "morph", "poolside", "qoder",
  "codebuddy", "commandcode", "alitp-intl", "bazaarlink", "api-airforce", "llm7", "local-device", "searxng",
];

const RANK = new Map(RANK_ORDER.map((id, i) => [id, i]));

// Position in the grid, lower first. Anything unranked goes after the list.
export const UNRANKED = RANK_ORDER.length;
export const rankOf = (id) => RANK.get(id) ?? UNRANKED;

// User-added endpoints land with the gateways, right after OpenRouter.
export const CUSTOM_ENDPOINT_RANK = rankOf("openrouter") + 0.5;

// registryId -> vendor, for "is this endpoint already on a vendor card?"
export const VENDOR_BY_ROUTE = Object.fromEntries(
  VENDORS.flatMap((v) => v.routes.map(([id]) => [id, v])),
);
