import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// JSON syntax alone does not guarantee a body that handlers can read fields from.
export async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body") };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Request body must be an object") };
  }
  return { body };
}
