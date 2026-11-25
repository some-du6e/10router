import { EXA_SEARCH_API } from "../shared.js";

export default {
  id: "exa",
  alias: "exa",
  display: {
    name: "Exa",
    icon: "manage_search",
    color: "#2563EB",
    textIcon: "EX",
    website: "https://exa.ai",
    notice: {
      apiKeyUrl: "https://dashboard.exa.ai/api-keys"
    }
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: [
    "webSearch",
    "webFetch"
  ],
  searchConfig: {
    ...EXA_SEARCH_API,
    baseUrl: "https://api.exa.ai/search",
    authType: "apikey",
    authHeader: "x-api-key",
    costPerQuery: 0.007,
    freeMonthlyQuota: 1000,
  },
  fetchConfig: {
    baseUrl: "https://api.exa.ai/contents",
    method: "POST",
    authType: "apikey",
    authHeader: "x-api-key",
    costPerQuery: 0.001,
    freeMonthlyQuota: 1000,
    formats: [
      "text",
      "markdown"
    ],
    maxCharacters: 100000,
    timeoutMs: 15000
  }
};
