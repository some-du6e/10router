// Older backups can contain credentials and switches for the removed proxy.
export function stripRetiredSettings(settings) {
  return Object.fromEntries(Object.entries(settings || {}).filter(([key]) =>
    !key.startsWith("mitm") && key !== "dnsToolEnabled"
  ));
}
