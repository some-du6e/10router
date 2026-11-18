import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A local MCP child gets what npx, npm and Node need to fetch and run the
// package (including private registries and corporate TLS), never the
// gateway's own secrets.
const CHILD_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NPM_TOKEN", "NODE_AUTH_TOKEN",
]);
const CHILD_ENV_PREFIXES = ["LC_", "XDG_", "NPM_CONFIG_"];
// NODE_OPTIONS can load code into the child; pass it only when it just
// switches Node to the system CA store.
const SAFE_NODE_OPTIONS = new Set(["--use-system-ca", "--use-openssl-ca"]);
// Never forwarded, even when an .npmrc names them.
const GATEWAY_SECRETS = new Set([
  "JWT_SECRET", "API_KEY_SECRET", "INITIAL_PASSWORD", "MACHINE_ID_SALT", "NINEROUTER_PEER_TOKEN",
]);

// Variables an .npmrc pulls in with ${NAME} (e.g. an _authToken for a private registry).
function npmrcReferences(env: NodeJS.ProcessEnv, cwd: string): Set<string> {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const files = [
    env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || path.join(home, ".npmrc"),
    path.join(cwd, ".npmrc"),
    env.npm_config_globalconfig || env.NPM_CONFIG_GLOBALCONFIG,
  ];
  const names = new Set<string>();
  for (const file of files) {
    if (!file) continue;
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
  }
  return names;
}

function isSafeNodeOptions(value: string | undefined): boolean {
  const flags = String(value || "").trim().split(/\s+/).filter(Boolean);
  return flags.length > 0 && flags.every((flag) => SAFE_NODE_OPTIONS.has(flag));
}

export function buildChildEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  const referenced = npmrcReferences(env, cwd);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    // npm hands npm_config_node_options to Node as NODE_OPTIONS, past the check below.
    if (GATEWAY_SECRETS.has(upper) || upper === "NPM_CONFIG_NODE_OPTIONS") continue;
    const keep = CHILD_ENV_KEYS.has(upper)
      || CHILD_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
      || referenced.has(key)
      || (upper === "NODE_OPTIONS" && isSafeNodeOptions(value));
    if (keep) out[key] = value;
  }
  return out;
}
