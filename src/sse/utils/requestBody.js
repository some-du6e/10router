import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "./logger.js";

/**
 * Read a JSON body that handlers can read fields from. Malformed JSON gets
 * "Invalid JSON body"; null, arrays and primitives get "Request body must be an
 * object". Both are 400s, logged under `logTag` when one is given.
 *
 * Chat passes its memory-admission ticket, which is told the body's length once
 * it is read. The text is local to this call, so it is not kept alive by the
 * caller's frame while the reply streams.
 *
 * @param {Request} request
 * @param {{ ticket?: import("../services/memoryAdmission.js").AdmissionTicket | null, logTag?: string | null }} [options]
 * @returns {Promise<{ body: Record<string, unknown>, error?: undefined } | { body?: undefined, error: Response }>}
 */
export async function readJsonObject(request, { ticket = null, logTag = null } = {}) {
  let body;
  try {
    const text = await request.text();
    ticket?.noteBodyLength(text.length);
    body = JSON.parse(text);
  } catch {
    return { error: rejectBody(logTag, "Invalid JSON body") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: rejectBody(logTag, "Request body must be an object") };
  }
  return { body };
}

/**
 * The 400 for a `model` that isn't a non-empty string, or null when it is one.
 * Logged under `logTag` when one is given.
 * @param {unknown} model
 * @param {string | null} [logTag]
 * @returns {Response | null}
 */
export function missingModel(model, logTag = null) {
  if (typeof model === "string" && model.trim()) return null;
  return rejectBody(logTag, "Missing model");
}

function rejectBody(logTag, message) {
  if (logTag) log.warn(logTag, message);
  return errorResponse(HTTP_STATUS.BAD_REQUEST, message);
}
