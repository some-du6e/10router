import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToChannel(row) {
  if (!row) return null;
  const data = parseJson(row.data, {});
  return {
    ...data,
    id: row.id,
    name: row.name,
    type: row.type,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function channelToRow(channel) {
  const { id, name, type, isActive, createdAt, updatedAt, ...data } = channel;
  return {
    id,
    name,
    type,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(data),
    createdAt,
    updatedAt,
  };
}

function upsert(db, channel) {
  const row = channelToRow(channel);
  db.run(
    `INSERT INTO notificationChannels(id, name, type, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, type=excluded.type, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [row.id, row.name, row.type, row.isActive, row.data, row.createdAt, row.updatedAt],
  );
}

export async function getNotificationChannels(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) {
    where.push("isActive = ?");
    params.push(filter.isActive ? 1 : 0);
  }
  if (filter.type) {
    where.push("type = ?");
    params.push(filter.type);
  }
  const sql = `SELECT * FROM notificationChannels${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  return db.all(sql, params).map(rowToChannel)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getNotificationChannelById(id) {
  const db = await getAdapter();
  return rowToChannel(db.get(`SELECT * FROM notificationChannels WHERE id = ?`, [id]));
}

export async function createNotificationChannel(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const channel = {
    id: data.id || uuidv4(),
    name: data.name,
    type: data.type,
    isActive: data.isActive !== false,
    events: data.events || [],
    config: data.config || {},
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, channel);
  return channel;
}

export async function updateNotificationChannel(id, data) {
  const db = await getAdapter();
  let updated = null;
  db.transaction(() => {
    const current = rowToChannel(db.get(`SELECT * FROM notificationChannels WHERE id = ?`, [id]));
    if (!current) return;
    updated = { ...current, ...data, id, updatedAt: new Date().toISOString() };
    upsert(db, updated);
  });
  return updated;
}

export async function deleteNotificationChannel(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    removed = rowToChannel(db.get(`SELECT * FROM notificationChannels WHERE id = ?`, [id]));
    if (removed) db.run(`DELETE FROM notificationChannels WHERE id = ?`, [id]);
  });
  return removed;
}
