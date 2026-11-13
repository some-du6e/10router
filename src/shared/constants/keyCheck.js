// Why the key check (/api/providers/validate) failed a key, and the sentences
// for it. The validator sends `reason` when the cause is not the key itself;
// the management API words its own answer from it, since it never passes the
// validator's text on.
export const NO_API_ROUTE = "no-api-route";
export const UNVERIFIED = "unverified";

// How long one OpenAI-compatible probe request may take.
export const PROBE_TIMEOUT_MS = 8000;

export const INVALID_KEY = "Invalid API key";
const WRONG_URL = "The endpoint URL looks wrong: it has no /models and no chat route";
// An inconclusive answer carries the upstream's status; a probe that timed out has none.
const noAnswer = (status) => (Number.isInteger(status)
  ? `the endpoint answered ${status} to the check`
  : `the endpoint didn't answer within ${PROBE_TIMEOUT_MS / 1000} seconds`);

// The validator's error text, which the dashboard shows.
export const KEY_CHECK_ERRORS = {
  [NO_API_ROUTE]: () => WRONG_URL,
  [UNVERIFIED]: (status) => `Couldn't check the key: ${noAnswer(status)}. Try again.`,
};

// The management API's answer and audit reason. A refused key or a wrong URL
// is the caller's to fix (422). An inconclusive answer is the upstream's
// (502): nothing shows whether the key works, so a retry may get it added.
export const MANAGEMENT_KEY_REFUSED = {
  status: 422,
  error: () => "The provider did not accept this key, so it was not added",
  audit: "the provider did not accept the key",
};
export const MANAGEMENT_KEY_CHECK = {
  [NO_API_ROUTE]: {
    status: 422,
    error: () => `${WRONG_URL}, so the key was not added`,
    audit: "no API route at the endpoint URL",
  },
  [UNVERIFIED]: {
    status: 502,
    error: (status) => `Couldn't check the key: ${noAnswer(status)}, so the key was not added. Try again.`,
    audit: "the endpoint's answer did not show whether the key works",
  },
};
