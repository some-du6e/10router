import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { structuredPreview } from "../../../shared/utils/requestConversation.js";
import { measureJson } from "../../../shared/utils/jsonMeasure.js";
import { readCgroupMemoryLimit } from "../../../shared/utils/cgroupMemory.js";
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
const FULL_DATA_MAX_BYTES = 16 * 1024 * 1024;
// JSON sizes are counted at 2 bytes a character: V8 stores a whole string that
// way once it holds any character above U+00FF, which prompts almost always do.
// The ring's entries and the queued capped records are counted this way.
const JSON_BYTES_PER_CHAR = 2;
// The most the payloads waiting for a full copy may take, counted by the
// size of their JSON (see fullRing).
const FULL_RING_MAX_BYTES = 256 * 1024 * 1024;
// A stream's row is saved twice, when it starts and when it ends, so past
// SAVES_PER_ROW × maxRecords queued saves the oldest are ones the trim would
// delete anyway. Queued records, a running write's included, are also capped
// in bytes; past it the oldest saves go, so a stream's end save can be lost
// and its row left looking unfinished. With full details on a record can take
// up to 1 MB (four fields of 128 KB, at 2 bytes a character), so in a 2 GiB
// container the cap holds about 60 to 120 records: several seconds of saves
// under heavy fallback, which a write that keeps up never reaches.
const SAVES_PER_ROW = 2;
const QUEUED_RECORDS_MAX_BYTES = 128 * 1024 * 1024;
// In a container, both caps are also held to a share of its memory limit
// (cgroup memory.max): a 2 GiB container gets a 102 MB ring and 61 MB of
// queued records. The values above are the ceilings, and apply as they are
// without a limit.
const FULL_RING_LIMIT_FRACTION = 0.05;
const QUEUED_RECORDS_LIMIT_FRACTION = 0.03;
// Rows written per transaction, so a catch-up write stays bounded.
const MAX_ROWS_PER_WRITE = 200;
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
        maxRecords: rowLimit(settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10)),
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
      maxRecords: rowLimit(settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10)),
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

// maxRecords as a usable row count: a non-numeric, zero or negative setting
// can't turn the queue's cap or the table's trim off.
function rowLimit(maxRecords) {
  const n = Math.floor(Number(maxRecords));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RECORDS;
}

// Saves waiting to be written, as buildSave builds them; their records' size,
// and that of the running write's.
let writeBuffer = [];
let queuedBytes = 0;
let inFlightBytes = 0;
let flushTimer = null;
let activeFlush = null;
let shuttingDown = false;
// The database driver, read once (sql.js never stores full copies).
let dbDriver = null;
/**
 * The byte caps for a container memory limit of `limitBytes` (null: none).
 * @param {number | null} limitBytes
 */
export function memoryCaps(limitBytes) {
  const cap = (ceiling, fraction) => (limitBytes > 0 ? Math.min(ceiling, Math.floor(limitBytes * fraction)) : ceiling);
  return {
    fullRingMaxBytes: cap(FULL_RING_MAX_BYTES, FULL_RING_LIMIT_FRACTION),
    queuedRecordsMaxBytes: cap(QUEUED_RECORDS_MAX_BYTES, QUEUED_RECORDS_LIMIT_FRACTION),
  };
}

// The byte caps in force; tests set smaller ones.
const limits = memoryCaps(readCgroupMemoryLimit());

// Credential headers never reach a stored request detail (the dashboard renders
// them and cloud sync uploads them).
function sanitizeHeaders(headers) {
  return dropSensitiveHeaders(headers);
}

// A streaming request is saved twice under one id, when it starts and when it
// ends, with the same request objects both times. Capping a ~1 MB body is
// the costly part of a save, so the second save reuses the first's capped
// record.
const cappedPayloads = new WeakMap();   // payload object → its capped copy
// Capped record → the UTF-8 bytes of its payload's JSON, from the same walk
// that capped it, so a full copy is sized without another one.
const payloadBytes = new WeakMap();

// The text a full copy's JSON has around its payloads: `{"key":`, `,"key":`
// and the closing `}`. Keys are ASCII, so these are their UTF-8 bytes too.
const partHead = (key, i) => `${i ? "," : "{"}${JSON.stringify(key)}:`;
const PARTS_TAIL = "}";

// UTF-8 bytes of a full copy's JSON, from what truncateField recorded for
// each cut payload, or undefined when it recorded none.
function fullCopyBytes(parts) {
  let bytes = PARTS_TAIL.length;
  for (let i = 0; i < parts.length; i++) {
    const n = payloadBytes.get(parts[i][2]);
    if (n === undefined) return undefined;
    bytes += partHead(parts[i][0], i).length + n;
  }
  return bytes;
}

// What a row's full copy is made from, or null when there is none to make:
// the payloads truncateField cut, by reference, with the size of their JSON
// at 2 bytes a character and its exact UTF-8 size. Nothing is serialized or
// walked here: a copy that is pushed out of the ring, or replaced by a later
// save of its row (a stream's end save), is never serialized at all. One over
// the ring's byte cap, or over FULL_DATA_MAX_BYTES of UTF-8, is skipped.
function fullCopySource(item, record) {
  const parts = [];
  let chars = 0;
  for (const key of PAYLOAD_KEYS) {
    if (record[key]?._truncated === true && item[key] != null) {
      parts.push([key, item[key], record[key]]);
      chars += record[key]._originalSize ?? 0;
    }
  }
  if (!parts.length) return null;
  if (chars > FULL_DATA_MAX_BYTES || chars * JSON_BYTES_PER_CHAR > limits.fullRingMaxBytes) return null;
  const utf8 = fullCopyBytes(parts);
  // UTF-8 takes at most 3 bytes per UTF-16 unit, so a copy is skipped only
  // when that bound is over the limit and its exact size is too, or unknown.
  if (chars * 3 > FULL_DATA_MAX_BYTES && !(utf8 <= FULL_DATA_MAX_BYTES)) return null;
  return { parts, bytes: chars * JSON_BYTES_PER_CHAR, utf8 };
}

// A full copy's JSON as UTF-8, written straight into one buffer of its exact
// size: no joined string, so nothing is flattened. The same bytes
// Buffer.from(JSON.stringify(...)) of the joined object gives. With the size
// known (`utf8`) only one payload's JSON is alive at a time; otherwise each
// is serialized first and sized natively. Null when it can't be serialized or
// is over FULL_DATA_MAX_BYTES.
function fullCopyBuffer(parts, utf8) {
  const serialize = (value) => {
    const json = JSON.stringify(value);
    if (typeof json !== "string") throw new Error("payload has no JSON");
    return json;
  };
  const known = utf8 !== undefined;
  const jsons = known ? null : parts.map(([, value]) => serialize(value));
  const total = known ? utf8 : jsons.reduce((sum, json, i) => sum + partHead(parts[i][0], i).length + Buffer.byteLength(json, "utf8"), PARTS_TAIL.length);
  if (total > FULL_DATA_MAX_BYTES) return null;
  const buffer = Buffer.allocUnsafe(total);
  let at = 0;
  const put = (text) => {
    const n = buffer.write(text, at, "utf8");
    // A short write means the size was off; never store a cut copy.
    if (n !== Buffer.byteLength(text, "utf8")) throw new Error("full copy size mismatch");
    at += n;
  };
  for (let i = 0; i < parts.length; i++) {
    put(partHead(parts[i][0], i));
    put(known ? serialize(parts[i][1]) : jsons[i]);
  }
  put(PARTS_TAIL);
  return at === total ? buffer : null;
}

// Serializes and gzips a full copy's source, or null: only for a row being
// written. Compression runs on the libuv pool so a big payload doesn't stall
// streams.
async function packSource(source) {
  try {
    const input = fullCopyBuffer(source.parts, source.utf8);
    if (!input) return null;
    return (await gzipAsync(input)).toString("base64");
  } catch {
    return null;
  }
}

// Full copies waiting to be written, only while "Show full request details" is
// on: row id → the source of its newest save's copy (that save is
// `source.save`), oldest-inserted first. Only FULL_DATA_KEEP_ROWS rows keep a
// copy after the trim, so a 26th id pushes the oldest out. Going over
// limits.fullRingMaxBytes does too, so with large payloads fewer than 25 rows get
// a new copy. A source holds its payload objects, not their JSON: those
// objects are the request's own, alive anyway while it runs, and a copy is
// serialized only for a row a write packs. Queued saves hold only their
// capped record.
const fullRing = new Map();
let fullRingBytes = 0;

function setRingEntry(id, source) {
  deleteRingEntry(id);
  if (!source) return;
  fullRing.set(id, source);
  fullRingBytes += source.bytes;
  while (fullRing.size > FULL_DATA_KEEP_ROWS || fullRingBytes > limits.fullRingMaxBytes) deleteRingEntry(fullRing.keys().next().value);
}

function deleteRingEntry(id) {
  const source = fullRing.get(id);
  if (!source) return;
  fullRing.delete(id);
  fullRingBytes -= source.bytes;
}

// The copy waiting for this save, taken out of the ring, or undefined.
function takeCopy(save) {
  const source = fullRing.get(save.id);
  if (source?.save !== save) return undefined;
  deleteRingEntry(save.id);
  return source;
}

// Throws on a corrupt value so callers can tell it apart from a missing one.
async function unpackFullData(value) {
  if (!value) return null;
  return JSON.parse((await gunzipAsync(Buffer.from(value, "base64"))).toString("utf8"));
}

export const __test__ = { sanitizeHeaders, getMaxJsonSize, truncateField, prettyJsonPrefix, fullCopySource, packSource, unpackFullData, limits,
  queued: () => writeBuffer.length, queuedBytes: () => queuedBytes, inFlightBytes: () => inFlightBytes,
  ringSize: () => fullRing.size, ringBytes: () => fullRingBytes,
  flush: () => flushToDatabase(), shutdown: () => _shutdownHandler() };

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

function truncateField(obj, maxSize) {
  if (obj === undefined || obj === null) return {};
  const cached = typeof obj === "object" ? cappedPayloads.get(obj) : undefined;
  // No JSON is kept with it (1 MB per body while the stream runs).
  if (cached?.maxSize === maxSize) return cached.truncated;
  const previewChars = Math.min(2000, Math.max(0, maxSize - 256));
  // A capped record needs only the JSON's length and head, which measureJson
  // reads without putting a body-sized string on the heap for every account a
  // request tries. What it can't measure is serialized.
  let measured = measureJson(obj, previewChars + 1);
  if (!measured) {
    let str;
    try {
      str = JSON.stringify(obj);
    } catch {
      return { _truncated: true, _originalSize: null, _preview: "[Payload could not be serialized]" };
    }
    measured = { length: str.length, prefix: str, bytes: Buffer.byteLength(str, "utf8") };
  }
  if (measured.length > maxSize) {
    const truncated = {
      _truncated: true,
      _originalSize: measured.length,
      _omittedSize: measured.length - maxSize,
      _preview: prettyJsonPrefix(measured.prefix, previewChars),
      _structuredPreview: null,
    };
    while (JSON.stringify(truncated).length > maxSize && truncated._preview.length > 0) {
      truncated._preview = truncated._preview.slice(0, Math.floor(truncated._preview.length / 2));
    }
    const remaining = maxSize - JSON.stringify(truncated).length;
    truncated._structuredPreview = structuredPreview(obj, remaining);
    payloadBytes.set(truncated, measured.bytes);
    if (typeof obj === "object") cappedPayloads.set(obj, { maxSize, truncated });
    return truncated;
  }
  return obj;
}

// A row written without a full copy keeps the one an earlier save of it stored
// (a stream's start save). Turning full details off clears stored copies, and
// the trim keeps them on the newest 25 rows only.
const UPSERT_SQL = `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data, fullData) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data, fullData = COALESCE(excluded.fullData, requestDetails.fullData)`;

// A flush already running drains the whole buffer, rows added meanwhile too,
// so callers wait on it rather than start a second one. Shutdown joins it as
// well; it stops packing full payloads once `shuttingDown` is set.
function flushToDatabase() {
  if (!activeFlush && writeBuffer.length > 0) activeFlush = writeBufferedRows();
  return activeFlush ?? Promise.resolve();
}

async function writeBufferedRows() {
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const saves = writeBuffer.splice(0, MAX_ROWS_PER_WRITE);
      inFlightBytes = saves.reduce((sum, save) => sum + save.bytes, 0);
      queuedBytes -= inFlightBytes;
      const generation = configCache.generation;
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      // A flush once shutdown starts packs nothing, checked per row: gzip eats
      // into the drain's listener budget, and the database closes when that runs out.
      const rows = [];
      for (const save of saves) {
        // Only a row's newest save has a copy in fullRing, so a write packs
        // at most FULL_DATA_KEEP_ROWS.
        const source = takeCopy(save);
        rows.push({ save, fullData: config.keepFullData && source && !shuttingDown ? await packSource(source) : null });
      }
      // The setting may have been turned off (and stored payloads cleared)
      // while compression was awaited. Nothing awaits between this check and
      // the transaction, so a clear can't slip in after it.
      if (generation !== configCache.generation) {
        for (const row of rows) row.fullData = null;
      }

      db.transaction(() => {
        for (const { save, fullData } of rows) {
          db.run(UPSERT_SQL, [save.id, save.timestamp, save.provider, save.model, save.connectionId, save.status, save.data, fullData]);
        }

        db.run(
          `UPDATE requestDetails SET fullData = NULL WHERE fullData IS NOT NULL AND id NOT IN (SELECT id FROM requestDetails ORDER BY timestamp DESC, id DESC LIMIT ?)`,
          [FULL_DATA_KEEP_ROWS]
        );

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    inFlightBytes = 0;
    // Cleared in the same tick as the last empty-buffer check, so a row saved
    // after it starts a new flush instead of joining one that's done.
    activeFlush = null;
    // A failed write leaves the saves made during it queued, and the save that
    // reached the batch size may have cancelled the timer: write them later.
    armFlushTimer();
  }
}

// A save as it waits to be written: the columns and the capped record stored
// in `data`, built now, so the save holds no body. With `keepFull` it also
// returns the source of its full copy (null for none), for fullRing.
function buildSave(item, maxJsonSize, keepFull) {
  if (!item.id) item.id = generateDetailId(item.model);
  if (!item.timestamp) item.timestamp = new Date().toISOString();
  if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);
  // A binary upstream body (Windsurf's protobuf starts with the API key) is
  // stored as its size only.
  for (const key of PAYLOAD_KEYS) if (isBinaryBody(item[key])) item[key] = binaryBodyMarker(item[key]);

  // Capped without serializing a payload whole, with `keepFull` too: a full
  // copy is serialized only when a write packs it.
  const record = {
    id: item.id,
    provider: item.provider || null,
    model: item.model || null,
    connectionId: item.connectionId || null,
    timestamp: item.timestamp,
    status: item.status || null,
    latency: item.latency || {},
    tokens: item.tokens || {},
    request: truncateField(item.request, maxJsonSize),
    providerRequest: truncateField(item.providerRequest, maxJsonSize),
    providerResponse: truncateField(item.providerResponse, maxJsonSize),
    response: truncateField(item.response, maxJsonSize),
    errorClass: item.errorClass || undefined,
  };
  const data = stringifyJson(record);
  const save = {
    id: record.id, timestamp: record.timestamp, provider: record.provider, model: record.model,
    connectionId: record.connectionId, status: record.status, data, bytes: data.length * JSON_BYTES_PER_CHAR,
  };
  return { save, source: keepFull ? fullCopySource(item, record) : null };
}

function armFlushTimer() {
  if (flushTimer || writeBuffer.length === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushToDatabase().catch(() => {});
  }, configCache.value?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
}

// A dropped save takes its waiting copy with it.
function dropOldestSave() {
  const dropped = writeBuffer.shift();
  queuedBytes -= dropped.bytes;
  takeCopy(dropped);
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  // No full copies are built during the shutdown drain, or on sql.js.
  const keepFull = config.keepFullData && !shuttingDown && (dbDriver ??= (await getAdapter()).driver) !== "sql.js";
  const { save, source } = buildSave(detail, config.maxJsonSize, keepFull);
  writeBuffer.push(save);
  queuedBytes += save.bytes;
  // A stream's end save replaces its start save's copy; one with none clears it.
  if (keepFull) setRingEntry(save.id, source && { ...source, save });

  // Past either cap the oldest saves go; the newest always stays.
  while (writeBuffer.length > 1 && (writeBuffer.length > SAVES_PER_ROW * config.maxRecords
    || queuedBytes + inFlightBytes > limits.queuedRecordsMaxBytes)) dropOldestSave();

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

// Drops every stored full payload and the copies waiting in fullRing, e.g.
// when "Show full request details" is turned off, and forgets the cached config
// so later saves and pending writes stop keeping them.
export async function clearRequestDetailFullData() {
  configCache.value = null;
  configCache.generation += 1;
  fullRing.clear();
  fullRingBytes = 0;
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
