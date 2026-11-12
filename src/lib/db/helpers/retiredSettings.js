// Older backups can contain credentials and switches for the removed proxy
// and the removed token savers.
const RETIRED_TOKEN_SAVER = /^(rtk|headroom|caveman|ponytail|pxpipe)[A-Z]/;

export function stripRetiredSettings(settings) {
  return Object.fromEntries(Object.entries(settings || {}).filter(([key]) =>
    !key.startsWith("mitm") && key !== "dnsToolEnabled" && !RETIRED_TOKEN_SAVER.test(key)
  ));
}
