export default {
  id: "opencode-zen",
  priority: 205,
  alias: "ocz",
  display: {
    name: "OpenCode Zen",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OZ",
    website: "https://opencode.ai/auth",
    notice: { text: "API key required for the paid Jev lane.", apiKeyUrl: "https://opencode.ai/auth" },
  },
  category: "apikey",
  authType: "apikey",
  models: [
    { id: "jev-1.13", name: "Jev 1.13", kind: "systemone" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
  ],
  serviceKinds: ["systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: { "x-opencode-client": "desktop", "User-Agent": "opencode/1.18.31" },
  },
};
