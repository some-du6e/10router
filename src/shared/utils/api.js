/**
 * API utility functions for making HTTP requests
 */

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

/**
 * Make a GET request
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function get(url, options = {}) {
  const response = await fetch(url, {
    method: "GET",
    ...options,
    headers: mergeHeaders(options.headers),
  });
  return handleResponse(response);
}

/**
 * Make a POST request
 * @param {string} url - API endpoint
 * @param {object} data - Request body
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function post(url, data, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(data),
    ...options,
    headers: mergeHeaders(options.headers),
  });
  return handleResponse(response);
}

/**
 * Make a PUT request
 * @param {string} url - API endpoint
 * @param {object} data - Request body
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function put(url, data, options = {}) {
  const response = await fetch(url, {
    method: "PUT",
    body: JSON.stringify(data),
    ...options,
    headers: mergeHeaders(options.headers),
  });
  return handleResponse(response);
}

/**
 * Make a DELETE request
 * @param {string} url - API endpoint
 * @param {object} options - Fetch options
 * @returns {Promise<object>}
 */
export async function del(url, options = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    ...options,
    headers: mergeHeaders(options.headers),
  });
  return handleResponse(response);
}

/**
 * Handle API response
 * @param {Response} response - Fetch response
 * @returns {Promise<object>}
 */
async function handleResponse(response) {
  if (response.ok && response.status === 204) return null;
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
  const headers = new Headers(DEFAULT_HEADERS);
  new Headers(customHeaders).forEach((value, key) => headers.set(key, value));
  return headers;
}

export function patch(url, data, options = {}) {
  return post(url, data, { ...options, method: "PATCH" });
}

const api = { get, post, put, patch, del };
export default api;
