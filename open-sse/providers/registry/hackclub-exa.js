import { EXA_SEARCH_API } from "../shared.js";

// Hack Club AI's Exa proxy: Exa's own request and response, authenticated with
// a Hack Club AI key. Searches count toward that account's daily spending limit.
export default {
  id: "hackclub-exa",
  alias: "hackclub-exa",
  display: {
    name: "Hack Club AI Search",
    icon: "travel_explore",
    color: "#EC3750",
    textIcon: "HC",
    website: "https://docs.ai.hackclub.com/api/exa.html",
    notice: {
      apiKeyUrl: "https://ai.hackclub.com/dashboard",
      text: "Exa web search through Hack Club AI, with a Hack Club AI key. Searches count toward that account's daily spending limit, so put Exa after it in a Web Search combo. Hack Club AI's rules limit who may use it and with which tools.",
    },
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: ["webSearch"],
  searchConfig: {
    ...EXA_SEARCH_API,
    baseUrl: "https://ai.hackclub.com/proxy/v1/exa/search",
    // Needs the key and runs no search, so a key check spends nothing.
    validateUrl: "https://ai.hackclub.com/proxy/v1/stats",
    validateMethod: "GET",
    authType: "apikey",
    authHeader: "bearer",
    costPerQuery: 0,
  },
};
