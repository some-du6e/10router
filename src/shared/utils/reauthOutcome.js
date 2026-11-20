/**
 * The id of the connection an auth flow saved. Routes answer with either
 * `{ connection: { id } }` or `{ connectionId }`.
 * @param {object} [result] - The auth flow's response body
 * @returns {string|null}
 */
export function authenticatedConnectionId(result) {
  return result?.connection?.id || result?.connectionId || null;
}

/**
 * Whether a sign-in re-authenticated the account the user picked.
 * - "none": no account was picked, so this was a plain add.
 * - "confirmed": the sign-in saved credentials to the picked account.
 * - "unconfirmed": it saved them elsewhere, or did not say where.
 * @param {string|null} reauthConnectionId - The account being re-authenticated
 * @param {object} [result] - The auth flow's response body
 * @returns {"none"|"confirmed"|"unconfirmed"}
 */
export function reauthOutcome(reauthConnectionId, result) {
  if (!reauthConnectionId) return "none";
  return authenticatedConnectionId(result) === reauthConnectionId ? "confirmed" : "unconfirmed";
}
