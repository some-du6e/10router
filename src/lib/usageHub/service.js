import { getProviderConnections, getProviderConnectionById, updateProviderConnection } from "@/lib/db/index.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { U } from "open-sse/services/usage/shared.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { demoAccounts, demoResponse } from "./demo.js";

const isDemo = () => process.env.TENROUTER_HUB_DEMO === "true";
const eligible = (account) => account && ["codex", "claude"].includes(account.provider)
  && ["oauth", "access_token"].includes(account.authType);

export class HubError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function accountMetadata(account) {
  const data = account.providerSpecificData || {};
  let claims = {};
  try { claims = JSON.parse(Buffer.from(account.idToken.split(".")[1], "base64url").toString())["https://api.openai.com/auth"] || {}; } catch {}
  const accountId = data.workspaceId || data.accountId || data.chatgptAccountId || claims.chatgpt_account_id;
  const plan = account.plan || data.planType || claims.chatgpt_plan_type;
  return {
    id: account.id, auth_index: account.id, provider: account.provider,
    ...(account.email ? { email: account.email } : {}), disabled: account.isActive === false,
    ...(account.provider === "codex" ? { id_token: {
      ...(accountId ? { chatgpt_account_id: accountId } : {}),
      ...(plan ? { chatgpt_plan_type: plan } : {}),
    } } : {}),
  };
}

export async function listHubAccounts() {
  const accounts = isDemo() ? demoAccounts : await getProviderConnections();
  return { files: accounts.filter(eligible).map(accountMetadata) };
}

async function getAccount(id) {
  if (typeof id !== "string" || !id) throw new HubError("auth_index is required");
  const account = isDemo() ? demoAccounts.find((a) => a.id === id) : await getProviderConnectionById(id);
  if (!eligible(account) || account.isActive === false) throw new HubError("Account not found or disabled", 404);
  return account;
}

export function resolveOperation(provider, body) {
  const targets = provider === "codex" ? [
    ["usage", "GET", U("codex").url],
    ["credits", "GET", U("codex").resetCreditsUrl],
    ["consume", "POST", U("codex").resetCreditsConsumeUrl],
  ] : [["usage", "GET", U("claude").oauthUrl]];
  const operation = targets.find(([, method, url]) => url && body.method === method && body.url === url);
  if (!operation) throw new HubError("Only supported quota and reset-credit operations are allowed", 403);
  return operation[0];
}

const pendingKey = Symbol.for("10router.usageHubPendingResets");
const pendingResets = () => globalThis[pendingKey] ||= new Map();

export async function hubApiCall(body) {
  let account = await getAccount(body.auth_index);
  const operation = resolveOperation(account.provider, body);
  let data;
  if (operation === "consume") {
    try { data = typeof body.data === "string" ? JSON.parse(body.data) : body.data; } catch { throw new HubError("Invalid reset data"); }
    if (!data || ![data.credit_id, data.redeem_request_id].every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) {
      throw new HubError("credit_id and redeem_request_id are required");
    }
    data = { credit_id: data.credit_id, redeem_request_id: data.redeem_request_id };
  }
  let status = 200;
  let result;
  if (isDemo()) {
    result = demoResponse(account, operation, data);
  } else {
    const proxyOptions = await resolveConnectionProxyConfig(account.providerSpecificData);
    if (account.authType === "oauth") {
      account = (await refreshAndUpdateCredentials(account, false, proxyOptions)).connection;
    }
    const fetchUsage = async () => {
      if (!account.accessToken) throw new HubError("Account needs reauthorization", 401);
      const metadata = accountMetadata(account);
      // Build headers ourselves. The caller cannot forward credentials to arbitrary hosts.
      const headers = { Authorization: `Bearer ${account.accessToken}`, Accept: "application/json", "Content-Type": "application/json" };
      if (account.provider === "codex") {
        headers["OpenAI-Beta"] = "codex-1";
        headers.Originator = "Codex Desktop";
        if (metadata.id_token?.chatgpt_account_id) headers["ChatGPT-Account-ID"] = metadata.id_token.chatgpt_account_id;
      } else headers["anthropic-beta"] = "oauth-2025-04-20";
      return proxyAwareFetch(body.url, {
        method: body.method, headers, ...(data ? { body: JSON.stringify(data) } : {}),
        redirect: "error", signal: AbortSignal.timeout(10000),
      }, proxyOptions);
    };
    let response = await fetchUsage();
    if (response.status === 401 && account.authType === "oauth" && account.refreshToken) {
      await response.body?.cancel();
      account = (await refreshAndUpdateCredentials(account, true, proxyOptions)).connection;
      response = await fetchUsage();
    }
    status = response.status;
    try { result = await response.json(); } catch {
      if (response.ok) throw new HubError("Provider returned an invalid quota response", 502);
      result = null;
    }
  }
  if (operation === "consume" && status >= 200 && status < 300 && ["reset", "already_redeemed"].includes(result?.code)) {
    const pending = pendingResets();
    for (const [id, expires] of pending) if (expires < Date.now()) pending.delete(id);
    pending.set(account.id, Date.now() + 60000);
  }
  return { status_code: status, body: JSON.stringify(result) };
}

export async function resetHubQuota(body) {
  const account = await getAccount(body.auth_index);
  if (account.provider !== "codex" || !(pendingResets().get(account.id) > Date.now())) {
    throw new HubError("Redeem a reset credit before clearing the cooldown", 409);
  }
  if (!isDemo()) {
    const locks = Object.fromEntries(Object.keys(account).filter((key) => key.startsWith("modelLock_")).map((key) => [key, null]));
    await updateProviderConnection(account.id, { ...locks, rateLimitedUntil: null, backoffLevel: 0, lastError: null, lastErrorAt: null, errorCode: null });
  }
  pendingResets().delete(account.id);
  return { status: "ok" };
}
