// Response and body helpers shared by the management API and the dashboard's
// management-keys routes.

export function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(status, error, extra = {}) {
  return json({ error, ...extra }, status);
}

/**
 * The request's JSON object body. With `allowed`, any other field is an error,
 * so a typo or a field this route doesn't take can't be silently ignored.
 * @returns {Promise<{ body: object } | { error: Response }>}
 */
export async function readBody(request, allowed = null) {
  const body = await request.json().catch(() => undefined);
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: fail(400, "Body must be a JSON object") };
  if (allowed) {
    const extra = Object.keys(body).filter((k) => !allowed.has(k));
    if (extra.length) return { error: fail(400, `Unknown or not allowed fields: ${extra.join(", ")}`) };
  }
  return { body };
}
