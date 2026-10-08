export async function readUsageHubResponse(response, fallbackMessage) {
  const data = await response.json().catch(() => {
    if (response.ok) throw new Error(fallbackMessage);
    return null;
  });
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" && data.error ? data.error : fallbackMessage);
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.enabled !== "boolean") {
    throw new Error(fallbackMessage);
  }
  return data;
}
