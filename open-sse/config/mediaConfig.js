// Central config for remote-media fetching security limits.

// Max bytes accepted from a remote image fetch (reject larger to prevent memory DoS).
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// Fetch timeout for remote media.
export const FETCH_TIMEOUT_MS = 10000;

// Magic-byte signatures -> mime. Each entry: { sig:[bytes], offset, mime }.
// offset>0 for containers where the signature is not at byte 0 (e.g. webp).
export const IMAGE_SIGNATURES = [
  { sig: [0x89, 0x50, 0x4e, 0x47], offset: 0, mime: "image/png" },
  { sig: [0xff, 0xd8, 0xff], offset: 0, mime: "image/jpeg" },
  { sig: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: "image/gif" },
  { sig: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: "image/webp", verifyWebp: true },
  { sig: [0x42, 0x4d], offset: 0, mime: "image/bmp" },
];

// Image types Anthropic accepts in an image block. The bytes must match the type.
export const CLAUDE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Text that stands in for media a target can't carry.
export const MEDIA_OMITTED_TEXT = {
  IMAGE: "[image omitted]",
  FILE: "[file omitted]",
  OTHER: "[content omitted]",
  // An old tool-result image dropped to keep a long session under the image cap
  EARLIER_IMAGE: "[earlier image omitted]",
};

// Note left in a tool result whose nth image was moved to the user turn after it.
export const imageAttachedBelowText = (n) => `[image ${n} attached below]`;

// Text for an image a target gets only as its URL.
export const imageUrlText = (url) => `[Image: ${url}]`;

// Tool-result text loses image and PDF data: URLs with a payload of at least
// this many characters (a screenshot is ~600K). Shorter ones, like a small icon
// inlined in a CSS file, and other types (fonts) are left alone, as is any
// bare base64 or hex.
export const INLINE_BASE64_MIN_CHARS = 1024;
export const SCRUBBED_DATA_URI_MIME = /^(image\/|application\/pdf$)/i;

// Long computer-use sessions: Anthropic takes at most 100 images and about
// 32 MB per request. Past either limit here, the oldest tool-result images
// are replaced in chunks of CHUNK, so the prompt prefix (and its cache) stays
// the same for many turns after each trim. User images and the newest
// KEEP_RECENT tool images are never dropped.
export const TOOL_IMAGE_CAP = {
  MAX_IMAGES: 80,
  MAX_BYTES: 24 * 1024 * 1024,
  CHUNK: 40,
  KEEP_RECENT: 8,
};

// Tokens one image counts as in local estimates: the context meter, billing
// and count_tokens. Upstreams charge an image roughly this much, not by the
// length of its base64.
export const IMAGE_TOKEN_ESTIMATE = 1600;

// Hostnames/IPs that must never be fetched (SSRF guard for loopback + cloud metadata).
export const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "metadata.google.internal",
]);
