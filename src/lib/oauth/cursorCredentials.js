export function isValidCursorAccessToken(value) {
  return typeof value === "string" && value.length >= 50;
}

export function isValidCursorMachineId(value) {
  return typeof value === "string" && /^[a-f0-9-]{32,}$/i.test(value.replace(/-/g, ""));
}
