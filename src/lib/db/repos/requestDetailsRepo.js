import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { structuredPreview } from "../../../shared/utils/requestConversation.js";
import { dropSensitiveHeaders, isBinaryBody, binaryBodyMarker } from "../../../../open-sse/utils/redact.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE_KB = 5;
const FULL_DETAIL_MAX_JSON_SIZE_KB = 128;
const CONFIG_CACHE_TTL_MS = 5000;
// Full copies of oversized payloads are kept only for the newest rows, and
// only when "Show full request details" is on, so the DB can't balloon.
const FULL_DATA_KEEP_ROWS = 25;
// Saves one row gets at most: a stream's row is saved when it starts and ends.
const SAVES_PER_ROW = 2;
// Queued saves that may still keep their whole bodies for a full copy: enough
// to cover the newest FULL_DATA_KEEP_ROWS rows. Older saves keep only their
// capped record, so the queue never holds more bodies than this.
const MAX_FULL_CANDIDATES = SAVES_PER_ROW * FULL_DATA_KEEP_ROWS;
// Rows written per transaction, so a backlog is drained in bounded steps.
const MAX_ROWS_PER_WRITE = 200;
const FULL_DATA_MAX_BYTES = 16 * 1024 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const PAYLOAD_KEYS = ["request", "providerRequest", "providerResponse", "response"];

// Kept on globalThis: bundles can load this module more than once, and every
// copy must see the clear when "Show full request details" is turned off.
// `generation` bumps on every clear, so a config read or a flush that started
// before the clear can tell its "keep full payloads" answer is stale.
const configCache = (globalThis.__requestDetailsConfigCache ??= { value: null, ts: 0, generation: 0 });

function getMaxJsonSize(settings) {
  const envValue = Number.parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "", 10);
  if (Number.isFinite(envValue) && envValue > 0) return envValue * 1024;

  const settingValue = Number(settings.observabilityMaxJsonSize);
  const configuredKb = Number.isFinite(settingValue) && settingValue > 0
    ? settingValue
    : DEFAULT_MAX_JSON_SIZE_KB;
  const maxKb = settings.showSensitiveRequestDetails === true && configuredKb === DEFAULT_MAX_JSON_SIZE_KB
    ? FULL_DETAIL_MAX_JSON_SIZE_KB
    : configuredKb;
  return maxKb * 1024;
}

async function getObservabilityConfig() {
  if (configCache.value && (Date.now() - configCache.ts) < CONFIG_CACHE_TTL_MS) return configCache.value;
  const generation = configCache.generation;
  const config = await readObservabilityConfig();
  // A clear ran while settings were read: don't cache the pre-clear answer.
  if (generation !== configCache.generation) return { ...config, keepFullData: false };
  configCache.value = config;
  configCache.ts = Date.now();
  return config;
}

async function readObservabilityConfig() {
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      return {
        enabled,
        maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: getMaxJsonSize(settings),
        keepFullData: settings.showSensitiveRequestDetails === true,
      };
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    return {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: getMaxJsonSize(settings),
      keepFullData: settings.showSensitiveRequestDetails === true,
    };
  } catch {
    return {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE_KB * 1024,
    };
  }
}

// Saves waiting to be written, as queueEntry builds them.
let writeBuffer = [];
// The saves, queued or in a running flush, that still hold their bodies
// (entry.full), oldest first; at most MAX_FULL_CANDIDATES.
let fullCandidates = [];
let flushTimer = null;
let activeFlush = null;
let shuttingDown = false;
let flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;

// Credential headers never reach a stored request detail (the dashboard renders
// them and cloud sync uploads them).
function sanitizeHeaders(headers) {
  return dropSensitiveHeaders(headers);
}

// A streaming request is saved twice under one id, when it starts and when it
// ends, with the same request objects both times. Capping and packing a ~1 MB
// body is the costly part of a flush, so the second save reuses the first's.
const cappedPayloads = new WeakMap();   // payload object → its capped copy
const packedFullData = new WeakMap();   // first capped field → its packed full copy

// Returns the untruncated payloads that truncateField cut, gzipped, or null.
// Compression runs on the libuv pool so a big payload doesn't stall streams.
// `fieldJson` holds the compact JSON truncateField already built for each
// field, so the full payload is assembled from it instead of serialized again
// inside the synchronous flush.
async function packFullData(item, record, fieldJson = {}) {
  const parts = [];
  let chars = 0;
  for (const key of PAYLOAD_KEYS) {
    if (record[key]?._truncated === true && item[key] != null) {
      parts.push([key, fieldJson[key]]);
      chars += record[key]._originalSize ?? 0;
    }
  }
  if (!parts.length) return null;
  // UTF-8 never takes fewer bytes than characters, so this skips oversized
  // payloads without serializing them a second time.
  if (chars > FULL_DATA_MAX_BYTES) return null;
  // Same capped objects as an earlier save (truncateField's cache): same bytes.
  const keys = parts.map(([key]) => key).join();
  const capped = parts.map(([key]) => record[key]);
  const prior = packedFullData.get(capped[0]);
  if (prior?.keys === keys && prior.capped.every((c, i) => c === capped[i])) return prior.packed;
  try {
    const json = `{${parts.map(([key, value]) => `${JSON.stringify(key)}:${value ?? JSON.stringify(item[key])}`).join(",")}}`;
    // A UTF-16 code unit is at most 3 UTF-8 bytes, so only count bytes when that bound could exceed the limit.
    if (json.length * 3 > FULL_DATA_MAX_BYTES && Buffer.byteLength(json, "utf8") > FULL_DATA_MAX_BYTES) return null;
    const packed = (await gzipAsync(json)).toString("base64");
    packedFullData.set(capped[0], { keys, capped, packed });
    return packed;
  } catch {
    return null;
  }
}

// Throws on a corrupt value so callers can tell it apart from a missing one.
async function unpackFullData(value) {
  if (!value) return null;
  return JSON.parse((await gunzipAsync(Buffer.from(value, "base64"))).toString("utf8"));
}

export const __test__ = { sanitizeHeaders, getMaxJsonSize, truncateField, prettyJsonPrefix, packFullData, unpackFullData, buffered: () => writeBuffer.length, fullCandidates: () => fullCandidates.length, MAX_FULL_CANDIDATES, flush: () => flushToDatabase(), shutdown: () => _shutdownHandler() };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

// First `limit` chars of JSON.stringify(value, null, 2), rebuilt from the compact
// JSON text so a large body is not serialized a second time just for a preview.
function prettyJsonPrefix(json, limit) {
  let out = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length && out.length < limit; i++) {
    const c = json[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "{" || c === "[") {
      const next = json[i + 1];
      if (next === "}" || next === "]") {
        out += c + next;
        i++;
      } else {
        depth++;
        out += `${c}\n${"  ".repeat(depth)}`;
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += `\n${"  ".repeat(depth)}${c}`;
    } else if (c === ",") {
      out += `,\n${"  ".repeat(depth)}`;
    } else if (c === ":") {
      out += ": ";
    } else {
      out += c;
    }
  }
  return out.substring(0, limit);
}

function truncateField(obj, maxSize, fieldJson, key) {
  if (obj === undefined || obj === null) return {};
  const cached = typeof obj === "object" ? cappedPayloads.get(obj) : undefined;
  // No JSON is kept with it (1 MB per body while the stream runs): packFullData
  // reuses its earlier full copy, or serializes again when it can't.
  if (cached?.maxSize === maxSize) return cached.truncated;
  let str;
  try {
    str = JSON.stringify(obj);
  } catch {
    return { _truncated: true, _originalSize: null, _preview: "[Payload could not be serialized]" };
  }
  if (str.length > maxSize) {
    if (fieldJson) fieldJson[key] = str;
    const truncated = {
      _truncated: true,
      _originalSize: str.length,
      _omittedSize: str.length - maxSize,
      _preview: prettyJsonPrefix(str, Math.min(2000, Math.max(0, maxSize - 256))),
      _structuredPreview: null,
    };
    while (JSON.stringify(truncated).length > maxSize && truncated._preview.length > 0) {
      truncated._preview = truncated._preview.slice(0, Math.floor(truncated._preview.length / 2));
    }
    const remaining = maxSize - JSON.stringify(truncated).length;
    truncated._structuredPreview = structuredPreview(obj, remaining);
    if (typeof obj === "object") cappedPayloads.set(obj, { maxSize, truncated });
    return truncated;
  }
  return obj;
}

// The newest FULL_DATA_KEEP_ROWS ids of one write's saves, ordered as the trim
// orders rows: by the timestamp each row ends up with (its last save here),
// then id. Whatever the table already holds, every row of this write that the
// trim leaves a full copy on is one of these.
function idsKeepingFullData(entries) {
  const stamps = new Map();
  for (const entry of entries) stamps.set(entry.id, String(entry.timestamp));
  const newestFirst = [...stamps].sort(([aId, a], [bId, b]) => (a !== b ? (a < b ? 1 : -1) : aId < bId ? 1 : -1));
  return new Set(newestFirst.slice(0, FULL_DATA_KEEP_ROWS).map(([id]) => id));
}

// maxRecords as a usable row count: a missing or broken setting can't turn the
// queue's cap or the table's trim off.
function rowLimit(maxRecords) {
  const n = Math.floor(Number(maxRecords));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RECORDS;
}

// A save as it waits to be written: the columns and the capped record as JSON,
// built now so the save holds no body. Only a save whose fields were cut and
// that may get a full copy also keeps the request it came from (`full`), until
// newer saves push it out of fullCandidates or it is written.
function queueEntry(item, { maxJsonSize, keepFullData }) {
  if (!item.id) item.id = generateDetailId(item.model);
  if (!item.timestamp) item.timestamp = new Date().toISOString();
  if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);
  // A binary upstream body (Windsurf's protobuf starts with the API key) is
  // stored as its size only.
  for (const key of PAYLOAD_KEYS) if (isBinaryBody(item[key])) item[key] = binaryBodyMarker(item[key]);

  const fieldJson = keepFullData ? {} : undefined;
  const record = {
    id: item.id,
    provider: item.provider || null,
    model: item.model || null,
    connectionId: item.connectionId || null,
    timestamp: item.timestamp,
    status: item.status || null,
    latency: item.latency || {},
    tokens: item.tokens || {},
    request: truncateField(item.request, maxJsonSize, fieldJson, "request"),
    providerRequest: truncateField(item.providerRequest, maxJsonSize, fieldJson, "providerRequest"),
    providerResponse: truncateField(item.providerResponse, maxJsonSize, fieldJson, "providerResponse"),
    response: truncateField(item.response, maxJsonSize, fieldJson, "response"),
    errorClass: item.errorClass || undefined,
  };
  const cut = PAYLOAD_KEYS.some((key) => record[key]?._truncated === true && item[key] != null);
  return {
    id: record.id, timestamp: record.timestamp, provider: record.provider, model: record.model,
    connectionId: record.connectionId, status: record.status, data: stringifyJson(record),
    keepFullData: keepFullData === true, cut,
    full: keepFullData && cut ? { item, record, fieldJson } : null,
  };
}

// Drops the bodies of saves that left fullCandidates' window or were written.
function pruneFullCandidates() {
  fullCandidates = fullCandidates.filter((entry) => entry.full);
}

const UPSERT_PREFIX = `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, fullData) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data, `;
const UPSERT_SQL = `${UPSERT_PREFIX}fullData = excluded.fullData`;
const UPSERT_KEEP_STORED_FULL_SQL = `${UPSERT_PREFIX}fullData = COALESCE(excluded.fullData, requestDetails.fullData)`;

// A flush already running drains the whole buffer, rows added meanwhile too,
// so callers wait on it rather than start a second one. Shutdown joins it as
// well; it stops packing full payloads once `shuttingDown` is set.
function flushToDatabase() {
  if (!activeFlush && writeBuffer.length > 0) activeFlush = writeBufferedRows();
  return activeFlush ?? Promise.resolve();
}

async function writeBufferedRows() {
  try {
    // Drain the buffer, saves added during an await included, in bounded writes.
    while (writeBuffer.length > 0) {
      const entries = writeBuffer.splice(0, MAX_ROWS_PER_WRITE);
      try {
        await writeEntries(entries);
      } finally {
        // Written or lost, these saves hold no bodies from here on.
        for (const entry of entries) entry.full = null;
        pruneFullCandidates();
      }
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    // Cleared in the same tick as the last empty-buffer check, so a row saved
    // after it starts a new flush instead of joining one that's done.
    activeFlush = null;
    // A failed write leaves the saves made during it queued, and the save that
    // reached the batch size may have cancelled the timer: write them later.
    armFlushTimer();
  }
}

async function writeEntries(entries) {
  const generation = configCache.generation;
  const db = await getAdapter();
  const config = await getObservabilityConfig();
  const maxRecords = rowLimit(config.maxRecords);

  // sql.js rewrites the whole DB file on every write, so it skips full payloads.
  // So does a flush once shutdown starts, checked per row: gzip eats into
  // the drain's listener budget, and the database closes when that runs out.
  const wantFull = config.keepFullData && db.driver !== "sql.js";
  // Only a row's last save here, and only rows the trim leaves a full copy on,
  // are packed. Gzipping every save of a backlog made the flush slower than
  // the requests feeding it.
  const keeping = wantFull ? idsKeepingFullData(entries) : null;
  const lastSave = new Map(entries.map((entry, i) => [entry.id, i]));
  const rows = [];
  for (const [i, entry] of entries.entries()) {
    const full = entry.full;
    const pack = wantFull && !shuttingDown && entry.keepFullData && lastSave.get(entry.id) === i
      && keeping.has(entry.id) && (full !== null || !entry.cut);
    // A row not packed keeps the full copy an earlier save stored (a stream's
    // start save shares its id with its end save); the trim clears it unless
    // the row is among the newest.
    rows.push({ entry, fullData: pack && full ? await packFullData(full.item, full.record, full.fieldJson) : null, keepStored: wantFull && !pack });
  }
  // The setting may have been turned off (and stored payloads cleared)
  // while compression was awaited. Nothing awaits between this check and
  // the transaction, so a clear can't slip in after it.
  if (generation !== configCache.generation) {
    for (const row of rows) { row.fullData = null; row.keepStored = false; }
  }

  db.transaction(() => {
    for (const { entry, fullData, keepStored } of rows) {
      db.run(keepStored ? UPSERT_KEEP_STORED_FULL_SQL : UPSERT_SQL,
        [entry.id, entry.timestamp, entry.provider, entry.model, entry.connectionId, entry.status, entry.data, fullData]
      );
    }

    db.run(
      `UPDATE requestDetails SET fullData = NULL WHERE fullData IS NOT NULL AND id NOT IN (SELECT id FROM requestDetails ORDER BY timestamp DESC, id DESC LIMIT ?)`,
      [FULL_DATA_KEEP_ROWS]
    );

    const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
    if (cnt && cnt.c > maxRecords) {
      db.run(
        `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
        [cnt.c - maxRecords]
      );
    }
  });
}

function armFlushTimer() {
  if (flushTimer || writeBuffer.length === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDatabase().catch(() => {});
  }, flushIntervalMs);
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}
  flushIntervalMs = config.flushIntervalMs;

  const entry = queueEntry(detail, config);
  writeBuffer.push(entry);
  if (entry.full) {
    fullCandidates.push(entry);
    // Saves this far back can't end up among the newest FULL_DATA_KEEP_ROWS
    // rows (a later save of the same row would be the one packed).
    while (fullCandidates.length > MAX_FULL_CANDIDATES) fullCandidates.shift().full = null;
  }
  // Past SAVES_PER_ROW × maxRecords queued saves, the oldest are ones the trim
  // would delete anyway. A running write holds at most MAX_ROWS_PER_WRITE more.
  const maxQueued = SAVES_PER_ROW * rowLimit(config.maxRecords);
  if (writeBuffer.length > maxQueued) {
    for (const dropped of writeBuffer.splice(0, writeBuffer.length - maxQueued)) dropped.full = null;
    pruneFullCandidates();
  }

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else {
    armFlushTimer();
  }
}

const SUMMARY_DROPPED_KEYS = ["request", "providerRequest", "providerResponse", "response"];

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  // summary: strip the payloads in SQL so a polled page doesn't parse them.
  const dataCol = filter.summary
    ? `CASE WHEN json_valid(data) THEN json_remove(data, '$.request', '$.providerRequest', '$.providerResponse', '$.response') ELSE data END AS data`
    : "data";
  const rows = db.all(
    `SELECT ${dataCol}, fullData IS NOT NULL AS hasFullData FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => {
    const detail = parseJson(r.data, {}) || {};
    // A row SQLite's JSON parser rejects (e.g. nested past its depth limit)
    // comes back whole; drop its payloads here.
    if (filter.summary) for (const key of SUMMARY_DROPPED_KEYS) delete detail[key];
    if (r.hasFullData) detail.hasFullData = true;
    return detail;
  });

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data, fullData IS NOT NULL AS hasFullData FROM requestDetails WHERE id = ?`, [id]);
  if (!row) return null;
  const detail = parseJson(row.data, null);
  if (detail) detail.hasFullData = Boolean(row.hasFullData);
  return detail;
}

// Drops every stored full payload, e.g. when "Show full request details" is
// turned off, and forgets the cached config so pending writes stop keeping them.
export async function clearRequestDetailFullData() {
  configCache.value = null;
  configCache.generation += 1;
  // Queued saves won't get a full copy now: let their bodies go.
  for (const entry of fullCandidates) entry.full = null;
  fullCandidates = [];
  const db = await getAdapter();
  const { changes } = db.run(`UPDATE requestDetails SET fullData = NULL WHERE fullData IS NOT NULL`);
  // Give the freed pages back so the payloads don't linger in the file. The
  // payloads are already gone, so a failed VACUUM (full disk, busy) is logged.
  if (changes > 0) {
    try {
      db.exec("VACUUM");
    } catch (error) {
      console.warn("[requestDetailsRepo] VACUUM after clearing full payloads failed:", error);
    }
  }
}

export class CorruptFullDataError extends Error {
  constructor(id, cause) {
    super(`Stored full payload for ${id} is corrupt: ${cause?.message}`, { cause });
    this.name = "CorruptFullDataError";
  }
}

// Untruncated payloads for a row, keyed like the record (only the cut ones).
export async function getRequestDetailFullData(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT fullData FROM requestDetails WHERE id = ?`, [id]);
  try {
    return await unpackFullData(row?.fullData);
  } catch (error) {
    throw new CorruptFullDataError(id, error);
  }
}

const _shutdownHandler = () => {
  shuttingDown = true;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  return flushToDatabase();
};

// The database adapters close the connection on these signals, and the drain
// (server-drain.js) runs listeners in the order they were added, awaiting each.
// Prepending puts the flush ahead of the close whichever registered first.
process.on("beforeExit", _shutdownHandler);
for (const signal of ["SIGINT", "SIGTERM"]) process.prependListener(signal, _shutdownHandler);
