export const ACCOUNT_ROUTING_OPTIONS = [
  { value: "fill-first", label: "Fill first" },
  { value: "round-robin", label: "Round robin" },
  { value: "soonest-reset", label: "Soonest reset" },
];

export const SOONEST_RESET_HINT = "Use Claude and Codex accounts whose weekly quota resets soonest, then their session reset. Keeps existing session affinity. Uses account priority while quota data is unavailable.";

export function providerRoutingOptions(provider) {
  return [
    { value: "inherit", label: "Use global setting" },
    ...ACCOUNT_ROUTING_OPTIONS.filter(option => option.value !== "soonest-reset" || provider === "claude" || provider === "codex"),
  ];
}
