type DeviceConfig = {
  clientId: string;
  deviceCodeUrl: string;
  deviceTokenUrl: string;
  deviceVerificationUrl: string;
};

const DEVICE_LOGIN_LIFETIME_SECONDS = 15 * 60;

function postJson(url: string, body: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Codex's device endpoints return an authorization code and PKCE verifier
// after approval. The caller exchanges them at the regular token endpoint.
export async function requestCodexDeviceCode(config: DeviceConfig) {
  const response = await postJson(config.deviceCodeUrl, { client_id: config.clientId });
  if (response.status === 404) {
    throw new Error("Codex device sign-in is unavailable. Try browser sign-in.");
  }
  if (!response.ok) throw new Error(`Codex device code request failed (HTTP ${response.status})`);

  const data = await response.json();
  const userCode = data?.user_code ?? data?.usercode;
  if (!data?.device_auth_id || typeof data.device_auth_id !== "string" || typeof userCode !== "string" || !userCode) {
    throw new Error("Codex did not return a valid device code");
  }
  const interval = Number(data.interval);
  return {
    device_code: data.device_auth_id,
    user_code: userCode,
    verification_uri: config.deviceVerificationUrl,
    interval: Number.isSafeInteger(interval) && interval > 0 ? interval : 5,
    expires_in: DEVICE_LOGIN_LIFETIME_SECONDS,
  };
}

export async function pollCodexDeviceCode(config: DeviceConfig, deviceCode: unknown, userCode: unknown) {
  if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode) {
    throw new Error("Missing Codex device authorization ID or user code");
  }
  const response = await postJson(config.deviceTokenUrl, {
    device_auth_id: deviceCode,
    user_code: userCode,
  });
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Codex device authorization failed (HTTP ${response.status})`);

  const data = await response.json();
  if (typeof data?.authorization_code !== "string" || !data.authorization_code
    || typeof data.code_verifier !== "string" || !data.code_verifier) {
    throw new Error("Codex did not return a valid authorization code and verifier");
  }
  return { code: data.authorization_code, verifier: data.code_verifier };
}
