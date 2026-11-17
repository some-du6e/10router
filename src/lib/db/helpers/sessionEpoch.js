import crypto from "node:crypto";

// Dashboard sessions carry the epoch they were issued under (`sep`); a new epoch
// revokes every earlier session. It lives in _meta: the DB export (Settings →
// backup/restore) never contains it and an import never wipes it, so a restore
// can't revive or reset it. The pre-migration safety backups in db/backups/
// (backupDbLite) do copy _meta, epoch included; that directory is owner-only,
// and restoring one by hand brings back that backup's epoch.
export const SESSION_EPOCH_META_KEY = "dashboardSessionEpoch";

export function newSessionEpoch() {
  return crypto.randomBytes(16).toString("hex");
}
