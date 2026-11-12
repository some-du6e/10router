// Why the key check (/api/providers/validate) failed a key when the cause is
// not the key itself. The validator sends it as `reason`; the management API
// words its own answer from it, since it never passes the validator's text on.
export const NO_API_ROUTE = "no-api-route";
export const UNVERIFIED = "unverified";

// The validator's error text, which the dashboard shows.
export const KEY_CHECK_ERRORS = {
  [NO_API_ROUTE]: () => "The endpoint URL looks wrong: it has no /models and no chat route",
  [UNVERIFIED]: (status) => `Couldn't check the key: the endpoint answered ${status} to the check. Try again.`,
};

// The management API's answer and audit reason. A wrong URL is the caller's
// to fix (422). An inconclusive answer is the upstream's (502): nothing shows
// whether the key works, so retrying later may get it added.
export const MANAGEMENT_KEY_CHECK = {
  [NO_API_ROUTE]: {
    status: 422,
    error: () => "The endpoint URL looks wrong: it has no /models and no chat route, so the key was not added",
    audit: "no API route at the endpoint URL",
  },
  [UNVERIFIED]: {
    status: 502,
    error: (status) => `Couldn't check the key: the endpoint answered ${status} to the check, so the key was not added. Try again.`,
    audit: "the endpoint's answer did not show whether the key works",
  },
};
