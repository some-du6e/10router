import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

/**
 * Read a JSON body that handlers can read fields from. Malformed JSON gets
 * "Invalid JSON body"; null, arrays and primitives get "Request body must be an
 * object". Both are 400s.
 *
 * Chat passes its memory-admission ticket, which is told the body's length once
 * it is read. The text is local to this call, so it is not kept alive by the
 * caller's frame while the reply streams.
 *
 * @param {Request} request
 * @param {{ ticket?: import("../services/memoryAdmission.js").AdmissionTicket | null }} [options]
 * @returns {Promise<{ body: Record<string, unknown>, error?: undefined } | { body?: undefined, error: Response }>}
 */
export async function readJsonObject(request, { ticket = null } = {}) {
  let body;
  try {
    const text = await request.text();
    ticket?.noteBodyLength(text.length);
    body = JSON.parse(text);
  } catch {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Request body must be an object") };
  }
  return { body };
}
