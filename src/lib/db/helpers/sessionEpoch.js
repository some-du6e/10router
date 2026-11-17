import crypto from "node:crypto";

// Dashboard sessions carry the epoch they were issued under (`sep`); a new epoch
// revokes every earlier session. It lives in _meta, which backups never contain
// and an import never wipes, so a restore can't revive or reset it.
export const SESSION_EPOCH_META_KEY = "dashboardSessionEpoch";

export function newSessionEpoch() {
  return crypto.randomBytes(16).toString("hex");
}
