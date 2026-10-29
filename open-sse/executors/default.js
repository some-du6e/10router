import { BaseExecutor } from "./base.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../config/providers.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_API_HOST, ANTHROPIC_COMPAT_BASE, selectAnthropicBeta } from "../providers/shared.js";
import { appendUrlPath, resolveOpenAICompatibleApiType, getTargetFormat } from "../services/provider.js";
import { OAUTH_ENDPOINTS, buildKimiHeaders } from "../config/appConstants.js";
import { buildClineHeaders } from "../shared/clineAuth.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { stripUnsupportedParams } from "../translator/concerns/paramSupport.js";
import {
  dropFirstPartyBetas, dropFirstPartyFieldsWithoutBeta, filterBetaHeaders, isAnthropicApiUrl, parseRejectedBetas, sentBetas, stripBetaBodyFields, splitBetas,
  BETA_HEADER_KEYS,
} from "../utils/anthropicBeta.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { installEndpointOverrides } from "../handlers/chatCore/endpointOverrides.js";

// Named-flag retries before the last-resort attempt with no anthropic-beta at all.
const MAX_BETA_RETRIES = 1;

// Auth header descriptors — derived from registry transport.auth, fallback to hardcoded defaults.
const BEARER = { combined: true, header: "Authorization", scheme: "bearer" };
const XAPIKEY = { combined: true, header: "x-api-key", scheme: "raw" };
const AUTH_DESCRIPTORS = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, t]) => t.auth)
    .map(([id, t]) => [id, t.auth])
);

// Apply a token to a header per scheme (matches legacy: combined always sets, even when undefined).
function setAuth(headers, spec, token) {
  headers[spec.header] = spec.scheme === "bearer" ? `Bearer ${token}` : token;
}

// Resolve auth onto headers from a descriptor.
function applyAuth(headers, desc, credentials) {
  if (desc.combined) {
    // combined providers always set the header (legacy behavior, incl. noAuth → "Bearer undefined")
    setAuth(headers, desc, credentials.apiKey || credentials.accessToken);
    if (desc.anthropicVersion && !headers["anthropic-version"]) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return;
  }
  // split apiKey/oauth: set only the matching branch (legacy: anthropic-compatible skips when both absent)
  if (credentials.apiKey) setAuth(headers, desc.apiKey, credentials.apiKey);
  else if (credentials.accessToken) setAuth(headers, desc.oauth, credentials.accessToken);
  if (desc.anthropicVersion && !headers["anthropic-version"]) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
}

// Provider-specific header quirks kept as small hooks (not pure auth).
const HEADER_HOOKS = {
  // Stable device_id from OAuth connection (CLIProxyAPI KimiTokenStorage.DeviceID)
  kimiHeaders: (h, c) => Object.assign(h, buildKimiHeaders(c?.providerSpecificData?.deviceId)),
  clineHeaders: (h, c) => Object.assign(h, buildClineHeaders(c.apiKey || c.accessToken)),
  kilocodeOrg: (h, c) => { if (c.providerSpecificData?.orgId) h["X-Kilocode-OrganizationID"] = c.providerSpecificData.orgId; },
};

// Config-driven OAuth refresh grants — derived from registry oauth.refresh.
const REFRESH_GRANTS = Object.fromEntries(
  Object.entries(PROVIDER_OAUTH)
    .filter(([, o]) => o.refresh)
    .map(([id, o]) => {
      const tokenUrl = o.tokenUrl;
      const encoding = o.refresh.encoding;
      const extraParams = o.refresh.scope ? { scope: o.refresh.scope } : {};
      return [id, {
        encoding,
        url: () => tokenUrl,
        params: (ex) => id === "gemini"
          ? { client_id: ex.config.clientId, client_secret: ex.config.clientSecret, ...extraParams }
          : { client_id: o.clientId, ...extraParams },
      }];
    })
);

export class DefaultExecutor extends BaseExecutor {
  constructor(provider) {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  transformRequest(model, body, _stream, credentials) {
    let transformed = this.applyJsonSchemaFallback(body);

    // Snowflake's Cortex OpenAI-compatible endpoint rejects the legacy
    // `max_tokens` field even though the rest of the Chat Completions shape is
    // compatible. Keep this opt-in so other OpenAI-compatible gateways retain
    // their existing request contract.
    // Chat Completions only: Anthropic Messages requires max_tokens, and a
    // two-path node can route some models there.
    if (
      this.targetFormat(credentials) === "openai" &&
      credentials?.providerSpecificData?.maxCompletionTokens === true &&
      transformed &&
      typeof transformed === "object" &&
      transformed.max_completion_tokens === undefined &&
      transformed.max_tokens !== undefined
    ) {
      transformed = {
        ...transformed,
        max_completion_tokens: transformed.max_tokens,
      };
      delete transformed.max_tokens;
    }

    if (transformed && typeof transformed === "object") {
      // quirk: some openai-compatible providers reject Anthropic's client_metadata field
      if (this.config.quirks?.dropClientMetadata) {
        delete transformed.client_metadata;
      }
      stripUnsupportedParams(this.provider, model, transformed);
      if (this.onMessagesPath(credentials)) {
        const psd = credentials?.providerSpecificData || {};
        transformed = stripBetaBodyFields({ ...transformed }, { dropped: psd.droppedBetas, stripAll: psd.stripBeta === true });
      }
    }

    return injectReasoningContent({ provider: this.provider, model, body: transformed });
  }

  // The wire format this request goes out in.
  targetFormat(credentials) {
    return credentials?.runtimeTransport?.format || getTargetFormat(this.provider, credentials);
  }

  // safeguards goes out only with its beta in the outgoing header, which
  // buildHeaders drops for third-party hosts unless an endpoint header line
  // adds it back. Whether Anthropic 400s or ignores safeguards without the
  // beta is unverified; the claude and anthropic providers' fixed beta lists
  // lack it, so they never send it. headers = null (unknown) drops it.
  finalizeBody(body, headers, credentials) {
    return this.targetFormat(credentials) === "claude" ? dropFirstPartyFieldsWithoutBeta(body, headers) : body;
  }

  // Fallback json_schema → json_object for openai-compatible providers without native Structured Output.
  applyJsonSchemaFallback(body) {
    if (!this.provider?.startsWith?.("openai-compatible-")) return body;
    const rf = body?.response_format;
    if (rf?.type !== "json_schema" || !rf.json_schema?.schema) return body;

    const schemaJson = JSON.stringify(rf.json_schema.schema, null, 2);
    const prompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;

    const messages = Array.isArray(body.messages) ? body.messages.map(m => ({ ...m })) : [];
    const sys = messages.find(m => m.role === "system");
    if (sys) {
      if (typeof sys.content === "string") sys.content = `${sys.content}\n\n${prompt}`;
      else if (Array.isArray(sys.content)) sys.content.push({ type: "text", text: `\n\n${prompt}` });
    } else {
      messages.unshift({ role: "system", content: prompt });
    }
    return { ...body, messages, response_format: { type: "json_object" } };
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Runtime transport (multi-endpoint providers): use the sourceFormat-matched endpoint
    const rt = credentials?.runtimeTransport;
    if (rt?.baseUrl) {
      return rt.urlSuffix ? `${rt.baseUrl}${rt.urlSuffix}` : rt.baseUrl;
    }
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return appendUrlPath(baseUrl, path);
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      return appendUrlPath(baseUrl, "/messages");
    }
    // gemini-format: build :streamGenerateContent / :generateContent path
    if (this.config.format === "gemini") {
      return `${this.config.baseUrl}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    }
    // urlSuffix (e.g. ?beta=true) declared per-provider in registry
    if (this.config.urlSuffix) {
      return `${this.config.baseUrl}${this.config.urlSuffix}`;
    }
    const url = this.config.baseUrl;
    if (url?.includes("{accountId}")) {
      const accountId = credentials?.providerSpecificData?.accountId;
      if (!accountId) throw new Error(`${this.provider} requires accountId in providerSpecificData`);
      return url.replace("{accountId}", accountId);
    }
    return url;
  }

  // Fallback descriptor for providers without an explicit entry in AUTH_DESCRIPTORS.
  resolveAuthDescriptor() {
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      return { apiKey: { header: "x-api-key", scheme: "raw" }, oauth: { header: "Authorization", scheme: "bearer" }, anthropicVersion: true };
    }
    if (this.config?.format === "claude") {
      return { ...XAPIKEY, anthropicVersion: true };
    }
    return BEARER;
  }

  buildHeaders(credentials, stream = true, url, model) {
    const rt = credentials?.runtimeTransport;
    const headers = { "Content-Type": "application/json", ...(rt ? rt.headers : this.config.headers) };
    const desc = rt?.auth || AUTH_DESCRIPTORS[this.provider] || this.resolveAuthDescriptor();
    // Hooks run BEFORE auth so dynamic overlays can't clobber the token.
    for (const hook of desc.hooks || []) HEADER_HOOKS[hook]?.(headers, credentials);
    applyAuth(headers, desc, credentials);
    // Azure-style custom endpoints take the key in an api-key header instead of Bearer.
    if (credentials?.providerSpecificData?.apiKeyHeader === "api-key" && credentials.apiKey && !this.onMessagesPath(credentials)) {
      delete headers["Authorization"];
      headers["api-key"] = credentials.apiKey;
    }

    if (this.provider === "claude" && model) {
      headers["Anthropic-Beta"] = selectAnthropicBeta(model);
    }

    // Strip first-party Claude Code identity headers for non-Anthropic anthropic-compatible
    // upstreams (including an openai-compatible node routing a model to its Messages path).
    if (this.onMessagesPath(credentials)) {
      // Forward the client's anthropic-beta (context-1m-*, interleaved-thinking, ...).
      // Messages paths only: OpenAI upstreams never see it.
      const clientBeta = credentials?.rawHeaders?.["anthropic-beta"];
      if (clientBeta) {
        const key = BETA_HEADER_KEYS.find((k) => k in headers) || BETA_HEADER_KEYS[0];
        headers[key] = [...new Set([...splitBetas(headers[key]), ...splitBetas(clientBeta)])].join(",");
      }
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
      // Substring match on purpose (relays keep master's auth); talksToAnthropic
      // checks the hostname for safeguards. Unifying them is a follow-up.
      const isOfficialAnthropic = baseUrl === "" || baseUrl.includes(ANTHROPIC_API_HOST);
      if (!isOfficialAnthropic) {
        // Some third-party Anthropic-compatible gateways require Bearer auth in
        // addition to x-api-key. Send both (x-api-key already set above) so
        // gateways that read either header succeed.
        if (credentials.apiKey && !headers["Authorization"]) {
          headers["Authorization"] = `Bearer ${credentials.apiKey}`;
        }
        delete headers["anthropic-dangerous-direct-browser-access"];
        delete headers["Anthropic-Dangerous-Direct-Browser-Access"];
        delete headers["x-app"];
        delete headers["X-App"];
      }
      // Strip claude-code-20250219, plus any flags this endpoint has rejected
      // before (learned in execute) or every flag when the user opted in. Runs
      // for official hosts too, so execute's retry actually drops what it learned.
      const psd = credentials?.providerSpecificData || {};
      filterBetaHeaders(headers, { dropped: psd.droppedBetas, stripAll: psd.stripBeta === true });
    }

    // Third-party hosts never get Anthropic-only flags; an endpoint header line
    // (applied after this) can still add one back as a deliberate opt-in.
    if (this.targetFormat(credentials) === "claude" && !this.talksToAnthropic(credentials)) dropFirstPartyBetas(headers);

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  // Custom endpoint request going to an Anthropic Messages path: the node's own
  // path, or a two-path route (credentials.runtimeTransport.compatibleRoute).
  onMessagesPath(credentials) {
    const route = credentials?.runtimeTransport?.compatibleRoute;
    if (route) return route === "anthropic";
    return !!this.provider?.startsWith?.("anthropic-compatible-");
  }

  // Anthropic's own API: a custom Messages endpoint on (or defaulting to)
  // api.anthropic.com, or a registry provider whose base URL is that host.
  // Decides where safeguards and its beta go; auth headers keep their own check.
  talksToAnthropic(credentials) {
    if (this.onMessagesPath(credentials)) return isAnthropicApiUrl(credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE);
    return isAnthropicApiUrl(this.config?.baseUrl);
  }

  // Anthropic-compatible gateways 400 on beta flags they don't know and name them,
  // sometimes a few at a time. Drop the named ones and retry (bounded), then as a
  // last resort send no beta header at all. Report what was learned.
  async execute(args) {
    let result = await super.execute(args);
    if (!this.onMessagesPath(args.credentials)) return result;
    const psd = args.credentials?.providerSpecificData || {};
    if (psd.stripBeta === true) return result;

    const learned = [];
    let droppedBetas = psd.droppedBetas || [];
    let stripAll = false;
    for (let attempt = 0; attempt <= MAX_BETA_RETRIES && result.response?.status === HTTP_STATUS.BAD_REQUEST; attempt++) {
      const sent = sentBetas(result.headers);
      if (!sent.size) break;
      const text = await result.response.clone().text().catch(() => "");
      const rejected = parseRejectedBetas(text).filter((f) => sent.has(f));
      if (!rejected.length) break;
      learned.push(...rejected);
      droppedBetas = [...new Set([...droppedBetas, ...rejected])];
      stripAll = attempt === MAX_BETA_RETRIES;
      args.log?.warn?.("BETA", `${this.provider} rejected anthropic-beta ${rejected.join(", ")}; retrying without${stripAll ? " any beta flags" : ""}`);
      result.response.body?.cancel?.().catch?.(() => {});
      const credentials = { ...args.credentials, providerSpecificData: { ...psd, droppedBetas, ...(stripAll ? { stripBeta: true } : {}) } };
      result = await super.execute({ ...args, credentials });
    }
    if (!learned.length) return result;
    // The gateway named these itself, so they're worth remembering even if the
    // final attempt failed for another reason.
    try { await args.onBetasRejected?.(droppedBetas); }
    catch (e) { args.log?.warn?.("BETA", `could not save dropped flags: ${e.message}`); }
    return { ...result, droppedBetas };
  }

  // Generic OAuth refresh for the common {grant_type, refresh_token, client_id[, ...]} shape.
  // grant = REFRESH_GRANTS[provider]; client creds resolved from PROVIDERS or this.config.
  refreshFromGrant(credentials, proxyOptions) {
    const grant = REFRESH_GRANTS[this.provider];
    const params = { grant_type: "refresh_token", refresh_token: credentials.refreshToken, ...grant.params(this) };
    return grant.encoding === "json"
      ? this.refreshWithJSON(grant.url(), params, proxyOptions)
      : this.refreshWithForm(grant.url(), params, proxyOptions);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;

    const refreshers = {
      claude: () => this.refreshFromGrant(credentials, proxyOptions),
      codex: () => this.refreshFromGrant(credentials, proxyOptions),
      iflow: () => this.refreshIflow(credentials.refreshToken, proxyOptions),
      gemini: () => this.refreshFromGrant(credentials, proxyOptions),
      kiro: () => this.refreshKiro(credentials.refreshToken, proxyOptions),
      cline: () => this.refreshCline(credentials.refreshToken, proxyOptions),
      clinepass: () => this.refreshCline(credentials.refreshToken, proxyOptions),
      kimi: () => this.refreshKimi(credentials, proxyOptions),
      "kimi-coding": () => this.refreshKimi(credentials, proxyOptions),
      kilocode: () => this.refreshKilocode(credentials.refreshToken, proxyOptions)
    };

    const refresher = refreshers[this.provider];
    if (!refresher) return null;

    try {
      const result = await refresher();
      if (result) log?.info?.("TOKEN", `${this.provider} refreshed`);
      return result;
    } catch (error) {
      log?.error?.("TOKEN", `${this.provider} refresh error: ${error.message}`);
      return null;
    }
  }

  async refreshWithJSON(url, body, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || body.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshWithForm(url, params, proxyOptions = null) {
    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: new URLSearchParams(params)
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || params.refresh_token, expiresIn: tokens.expires_in };
  }

  async refreshIflow(refreshToken, proxyOptions = null) {
    const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);
    const response = await proxyAwareFetch(OAUTH_ENDPOINTS.iflow.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Authorization": `Basic ${basicAuth}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: PROVIDERS.iflow.clientId, client_secret: PROVIDERS.iflow.clientSecret })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKiro(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "kiro-cli/1.0.0" },
      body: JSON.stringify({ refreshToken })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || refreshToken, expiresIn: tokens.expiresIn };
  }

  async refreshCline(refreshToken, proxyOptions = null) {
    const response = await proxyAwareFetch(PROVIDERS.cline.refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" })
    }, proxyOptions);
    if (!response.ok) return null;
    const payload = await response.json();
    const data = payload?.data || payload;
    const expiresAtIso = data?.expiresAt;
    const expiresIn = expiresAtIso ? Math.max(1, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000)) : undefined;
    let accessToken = data?.accessToken;
    if (accessToken && !accessToken.startsWith("workos:")) {
      accessToken = `workos:${accessToken}`;
    }
    return { accessToken, refreshToken: data?.refreshToken || refreshToken, expiresIn };
  }

  // CLIProxyAPI DeviceFlowClient.RefreshToken — form body + X-Msh-* headers + stable device_id
  async refreshKimi(credentials, proxyOptions = null) {
    const refreshToken = credentials.refreshToken;
    const cfg = PROVIDERS.kimi || PROVIDERS["kimi-coding"];
    if (!cfg?.refreshUrl || !cfg?.clientId) return null;
    const kimiHeaders = buildKimiHeaders(credentials?.providerSpecificData?.deviceId);
    const response = await proxyAwareFetch(cfg.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        ...kimiHeaders
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId })
    }, proxyOptions);
    if (!response.ok) return null;
    const tokens = await response.json();
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  }

  async refreshKilocode(refreshToken, proxyOptions = null) {
    // Kilocode uses device code flow, no refresh token support
    return null;
  }
}

// Custom endpoints' Advanced / Ultra advanced settings (no-op for other providers).
installEndpointOverrides(DefaultExecutor);

export default DefaultExecutor;
