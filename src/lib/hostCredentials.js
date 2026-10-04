import { getAdapter } from "./db/driver.js";
import { parseJson } from "./db/helpers/jsonCol.js";
import { encryptHostPassword, decryptHostPassword } from "./db/helpers/hostCredentials.js";

export async function loadHostPassword(name) {
  const db = await getAdapter();
  const row = db.get("SELECT value FROM kv WHERE scope = 'hostCredentials' AND key = ?", [name]);
  return row ? decryptHostPassword(parseJson(row.value)) : "";
}

export async function saveHostPassword(name, password) {
  const db = await getAdapter();
  if (!password) {
    db.run("DELETE FROM kv WHERE scope = 'hostCredentials' AND key = ?", [name]);
    return;
  }
  db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('hostCredentials', ?, ?)", [name, JSON.stringify(encryptHostPassword(password))]);
}
