// A local MCP child gets only what npx and Node need to resolve and run the
// package, never the gateway's secrets.
const CHILD_ENV_KEYS = new Set([
  "PATH", "PATHEXT", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
]);
const CHILD_ENV_PREFIXES = ["LC_", "XDG_", "NPM_CONFIG_"];

export function buildChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (CHILD_ENV_KEYS.has(upper) || CHILD_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      out[key] = value;
    }
  }
  return out;
}
