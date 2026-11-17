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

// Cloudflare Workers AI image and mask inputs: the chat set (BMP included) plus
// AVIF (an ISO-BMFF "ftyp" box with brand avif or avis at byte 4). HEIC isn't
// listed: Cloudflare doesn't document taking it.
const ftyp = (brand) => ({ sig: [..."ftyp" + brand].map((c) => c.charCodeAt(0)), offset: 4, mime: "image/avif" });
export const CLOUDFLARE_IMAGE_SIGNATURES = [...IMAGE_SIGNATURES, ftyp("avif"), ftyp("avis")];

// Redirects a Cloudflare image or mask URL may take; each hop is checked again.
export const CLOUDFLARE_IMAGE_MAX_REDIRECTS = 3;

// Image types Anthropic accepts in an image block. The bytes must match the type.
export const CLAUDE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Text that stands in for media a target can't carry.
export const MEDIA_OMITTED_TEXT = {
  IMAGE: "[image omitted]",
  FILE: "[file omitted]",
  OTHER: "[content omitted]",
  // An old image (tool-result or user) dropped to keep a long session under the image limits
  EARLIER_IMAGE: "[earlier image omitted]",
};

// Note left in a tool result whose nth image was moved to the user turn after it.
export const imageAttachedBelowText = (n) => `[image ${n} attached below]`;

// Text for an image a target gets only as its URL.
export const imageUrlText = (url) => `[Image: ${url}]`;

// Tool-result text loses image and PDF data: URLs with a payload of at least
// this many characters. A screenshot is ~600K; the icons and fonts inlined in
// CSS, HTML, SVG or Markdown files are far smaller, so a file the model reads
// and edits comes through as it is. Other types and any bare base64 or hex
// are left alone.
export const INLINE_BASE64_MIN_CHARS = 64 * 1024;
export const SCRUBBED_DATA_URI_MIME = /^(image\/|application\/pdf$)/i;

// Long computer-use sessions: per-target image limits for the window in
// translator/concerns/toolImageCap.ts. The images are walked oldest first;
// when the window passes a `trigger`, its oldest images are replaced until it
// is back at `target`, tool-result images first. User images go when the
// window is still over a trigger with no tool image left to drop (then down
// to `target` too), or when they are the large images the hi-res rule is
// about. The newest image is always kept. A new image moves the window only
// when it crosses a trigger, so the prompt prefix (and its cache) stays the
// same between trims. `hard` is the upstream's own limit, kept here as
// documentation and for the tests that pin trigger and target to it; the
// window itself only reads `trigger` and `target`. Bytes are base64
// characters, which is what the request carries. A limit left out doesn't
// apply to that target.
const ANTHROPIC_IMAGES = { hard: 100, trigger: 80, target: 50 };
const ANTHROPIC_BASE64_BYTES = { hard: 30_000_000, trigger: 24_000_000, target: 15_000_000 }; // under ~32 MB, with room for text
export const IMAGE_WINDOW = {
  // Anthropic: 100 images, ~32 MB per request, and no more than 20 images once
  // any of them is over 2000 px on a side. A URL image is fetched upstream at
  // a size we can't read, so it counts, as large.
  CLAUDE: {
    images: ANTHROPIC_IMAGES,
    base64Bytes: ANTHROPIC_BASE64_BYTES,
    hiRes: { maxSide: 2000, trigger: 20, target: 16 },
    countUrlImages: true,
  },
  // Kiro's own image limits aren't documented. It serves the same models, so
  // count and size are capped like Claude's, without the hi-res rule. A URL
  // image reaches Kiro as "[Image: <url>]" text, so it doesn't count.
  KIRO: {
    images: ANTHROPIC_IMAGES,
    base64Bytes: ANTHROPIC_BASE64_BYTES,
    countUrlImages: false,
  },
  // Gemini: no image-count or hi-res rule, but inline data has to fit in a
  // 20 MB request (Gemini API docs, "larger than 20 MB, use the File API").
  // A URL image goes as fileData or text, so it doesn't count.
  GEMINI: {
    base64Bytes: { hard: 18_000_000, trigger: 14_400_000, target: 9_000_000 },
    countUrlImages: false,
  },
};

// Tokens one image counts as in local estimates: the context meter, billing
// and count_tokens. Upstreams charge an image roughly this much, not by the
// length of its base64.
export const IMAGE_TOKEN_ESTIMATE = 1600;
