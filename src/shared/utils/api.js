/**
 * API utility functions for making HTTP requests.
 * Every helper resolves with the parsed JSON body (null for 204) and throws on
 * a non-2xx response, with `status` and `data` attached to the error.
 */

/**
 * @param {string} method - HTTP method
 * @param {string} url - API endpoint
 * @param {object} [data] - Request body, sent as JSON when defined
 * @param {object} [options] - Fetch options
 * @returns {Promise<object|null>}
 */
async function request(method, url, data, options = {}) {
  const response = await fetch(url, {
    method,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    ...options,
    headers: mergeHeaders(options.headers),
  });
  return handleResponse(response);
}

export const get = (url, options) => request("GET", url, undefined, options);
export const post = (url, data, options) => request("POST", url, data, options);
export const put = (url, data, options) => request("PUT", url, data, options);
export const patch = (url, data, options) => request("PATCH", url, data, options);
export const del = (url, options) => request("DELETE", url, undefined, options);

async function handleResponse(response) {
  if (response.status === 204) return null;
  const data = await response.json().catch((error) => {
    if (response.ok) throw error;
    return null;
  });

  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : data?.error?.message;
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function mergeHeaders(customHeaders) {
  const headers = new Headers(customHeaders);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return headers;
}

const api = { get, post, put, patch, del };
export default api;
