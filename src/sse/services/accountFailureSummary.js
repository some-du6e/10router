function extractProviderMessage(error) {
  const text = typeof error === "string" ? error : JSON.stringify(error || "Provider error");
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return text;

  try {
    const payload = JSON.parse(text.slice(jsonStart));
    return payload?.error?.message || payload?.message || text;
  } catch {
    return text;
  }
}

export function summarizeAccountFailures(provider, model, failures) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return `All accounts unavailable for [${provider}/${model}]`;
  }

  const details = failures.map(({ account, status, error }) => {
    const name = account || "Unnamed account";
    const statusLabel = status ? `HTTP ${status}` : "provider error";
    return `${name} (${statusLabel}): ${extractProviderMessage(error)}`;
  });

  return `All ${failures.length} accounts unavailable for [${provider}/${model}]. ${details.join(" | ")}`;
}
