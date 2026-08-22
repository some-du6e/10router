import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Bake the git commit into the bundle at build time. `.git` isn't copied into
// `.next/standalone`, so a runtime rev-parse would fail in production builds —
// we resolve it once here, when the git tree is still present. The Docker build
// context strips `.git` (`.dockerignore`), so fall back to the `SOURCE_COMMIT`
// build var that CI injects (Coolify, GitHub Actions, Nixpacks). Empty string
// when there's neither (e.g. `npm i -g 10router` from a tarball).
function readGitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString().trim();
  } catch {}
  const fromEnv = process.env.SOURCE_COMMIT;
  // CI build vars are usually full 40-char shas; shorten to match `rev-parse --short`.
  return fromEnv ? fromEnv.slice(0, 7) : "";
}
const GIT_COMMIT = readGitCommit();
// CLI bundling needs workspace root so tracing includes hoisted node_modules (slim ~50MB).
// Docker / default uses projectRoot so server.js lands at /app/server.js (not nested).
const tracingRoot = process.env.NEXT_TRACING_ROOT_MODE === "workspace"
  ? join(projectRoot, "..")
  : projectRoot;
// Prefer the new TENROUTER_* name; the legacy NINEROUTER_* name still works for existing setups.
const proxyClientMaxBodySize = process.env.TENROUTER_PROXY_CLIENT_MAX_BODY_SIZE
  || process.env.NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE
  || "128mb";

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  output: "standalone",
  // `open` must stay external. It derives its own directory from `import.meta.url`, and
  // webpack replaces that with the absolute path of the BUILD machine as a string literal.
  // A release built on macOS therefore ships `file:///Users/.../open/index.js`, which
  // `fileURLToPath` rejects on Windows ("File URL path must be absolute" — no drive
  // letter). That throw happens at module scope, so every consumer of `open` dies on
  // import — including xAI/Grok token refresh, which loads the OAuth service that imports
  // it. Keeping it external preserves the real `import.meta.url` at runtime.
  serverExternalPackages: ["better-sqlite3", "sql.js", "node:sqlite", "bun:sqlite", "open"],
  turbopack: {
    root: tracingRoot
  },
  outputFileTracingRoot: tracingRoot,
  outputFileTracingExcludes: {
    "*": ["./gitbook/**/*"]
  },
  images: {
    unoptimized: true
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: GIT_COMMIT,
  },
  experimental: {
    // #1529/#1572: LLM clients can send long context or base64 image payloads through /v1 rewrites.
    proxyClientMaxBodySize,
    // Cache fetch responses across HMR refreshes for faster dev reloads.
    serverComponentsHmrCache: true,
    // Tree-shake heavy barrel imports to cut compile + bundle size
    optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"],
  },
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Exclude non-source dirs from watcher to reduce inotify load
    config.watchOptions = {
      ...config.watchOptions,
      aggregateTimeout: 300,
      ignored: /[\\/](node_modules|\.git|logs|\.next|\.next-cli-build|gitbook|cli|open-sse\.old|tests|docs)[\\/]/,
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      // Codex-native ingress. Configuring the Codex CLI/IDE with
      // `base_url = "<host>/backend-api/codex"` makes it use the ChatGPT wire
      // (native model catalog + `requires_openai_auth`) instead of the plain
      // OpenAI one. Some clients unconditionally append `/v1` to the configured
      // base URL, so collapse that duplicated prefix first.
      {
        source: "/backend-api/codex/v1/:path*",
        destination: "/api/v1/codex/:path*"
      },
      {
        source: "/backend-api/codex/:path*",
        destination: "/api/v1/codex/:path*"
      },
      {
        source: "/responses",
        destination: "/api/v1/responses"
      },
      {
        source: "/v1beta/:path*",
        destination: "/api/v1beta/:path*"
      },
      {
        source: "/v1beta",
        destination: "/api/v1beta"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  }
};

export default nextConfig;
