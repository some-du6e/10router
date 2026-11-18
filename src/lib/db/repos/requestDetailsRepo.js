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
// Saves whose timestamps tie (same millisecond) can sort by id against the
// order they were made in; a few extra slots cover that.
const SAME_MS_SLACK = 8;
// Queued saves that may still keep the JSON of their cut fields for a full
// copy: enough to cover the newest FULL_DATA_KEEP_ROWS rows. Older saves keep
// only their capped record.
const MAX_FULL_CANDIDATES = SAVES_PER_ROW * FULL_DATA_KEEP_ROWS + SAME_MS_SLACK;
// And at most this much of what they hold (each distinct string once,
// estimated at 2 bytes a char), oldest dropped first, so a few huge histories
// can't fill memory either. A running write stops packing once its packed
// copies would take the total past it.
const FULL_CANDIDATES_MAX_BYTES = 256 * 1024 * 1024;
// Capped records waiting to be written, queued and in a running write together
// (estimated the same way). Past it the oldest queued records are cut down to
// a small one (degradeRecord), and once all are, the oldest are dropped.
const QUEUED_RECORDS_MAX_BYTES = 64 * 1024 * 1024;
// A degraded record keeps each payload as a preview of this many characters,
// which keeps it within about DEGRADED_RECORD_MAX_BYTES.
const DEGRADED_PREVIEW_CHARS = 1024;
const DEGRADED_RECORD_MAX_BYTES = 10 * 1024;
// The most rows maxRecords may keep.
const MAX_RECORDS_LIMIT = 10000;
// One write takes at most this many rows, or this much of their records, so a
// backlog is drained in bounded steps.
const MAX_ROWS_PER_WRITE = 200;
const WRITE_MAX_BYTES = 32 * 1024 * 1024;
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

// Saves waiting to be written, as queueEntry builds them, and the estimated
// bytes of their records and of the running write's.
let writeBuffer = [];
let queuedBytes = 0;
let inFlightBytes = 0;
// How many of the queue's oldest saves are cut down (fitQueue degrades oldest first).
let degradedCount = 0;
// The saves, queued or in a running write, that still hold what their full
// copy is made from (entry.full), oldest first.
let fullCandidates = [];
// Every string those saves hold for full copies, each distinct one once:
// string → { text, refs }. Equal JSON from two saves (a
// stream's start and end, or the same body on two keys) is one string.
const heldStrings = new Map();
let fullCandidateBytes = 0;
// The byte budgets; tests set smaller ones.
const limits = {
  fullCandidatesMaxBytes: FULL_CANDIDATES_MAX_BYTES,
  queuedRecordsMaxBytes: QUEUED_RECORDS_MAX_BYTES,
  writeMaxBytes: WRITE_MAX_BYTES,
};
// A JS string takes at most 2 bytes a character.
const estimateBytes = (text) => 2 * text.length;
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

// The fields truncateField cut, as [key, json, capped] parts to pack, or null
// when none was cut, they can't be serialized, or together they are over
// FULL_DATA_MAX_BYTES (UTF-8): such a save gets no full copy. `json` is the
// compact JSON truncateField built (`fieldJson`), so a field isn't serialized
// again. A field capped from truncateField's cache has none: `jsonFor(capped)`
// may supply it (a queued save's), else it is serialized here. Parts an
// earlier save packed the same way need no JSON.
function fullDataParts(item, record, fieldJson = {}, jsonFor = () => undefined) {
  const parts = [];
  let chars = 0;
  for (const key of PAYLOAD_KEYS) {
    if (record[key]?._truncated === true && item[key] != null) {
      parts.push([key, fieldJson[key], record[key]]);
      chars += record[key]._originalSize ?? 0;
    }
  }
  // UTF-8 never takes fewer bytes than characters, so this skips oversized
  // payloads without serializing them a second time.
  if (!parts.length || chars > FULL_DATA_MAX_BYTES) return null;
  if (priorPack(parts)) return parts;
  let utf8 = 0;
  for (const part of parts) {
    if (part[1] === undefined) part[1] = jsonFor(part[2]);
    if (part[1] === undefined) {
      try { part[1] = JSON.stringify(item[part[0]]); } catch { return null; }
      if (typeof part[1] !== "string") return null;
    }
    // A UTF-16 code unit is at most 3 UTF-8 bytes, so only count bytes when that bound could exceed the limit.
    utf8 += part[1].length * 3 > FULL_DATA_MAX_BYTES ? Buffer.byteLength(part[1], "utf8") : part[1].length;
  }
  return utf8 > FULL_DATA_MAX_BYTES ? null : parts;
}

const liveCapped = (part) => (part[2] instanceof WeakRef ? part[2].deref() : part[2]);

// The packed copy of an earlier save with the same capped fields
// (truncateField's cache): the same bytes.
function priorPack(parts) {
  const capped = parts.map(liveCapped);
  const prior = capped[0] && packedFullData.get(capped[0]);
  const keys = parts.map(([key]) => key).join();
  return prior?.keys === keys && prior.capped.every((c, i) => c === capped[i]) ? prior.packed : null;
}

// Gzips the parts into one JSON object, or null. Compression runs on the
// libuv pool so a big payload doesn't stall streams.
async function packParts(parts) {
  const prior = priorPack(parts);
  if (prior) return prior;
  if (parts.some(([, json]) => typeof json !== "string")) return null;
  try {
    const json = `{${parts.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
    if (json.length * 3 > FULL_DATA_MAX_BYTES && Buffer.byteLength(json, "utf8") > FULL_DATA_MAX_BYTES) return null;
    const packed = (await gzipAsync(json)).toString("base64");
    // Kept for a later save of the same objects (a stream's end save) only while they live.
    const capped = parts.map(liveCapped);
    if (capped.every(Boolean)) packedFullData.set(capped[0], { keys: parts.map(([key]) => key).join(), capped, packed });
    return packed;
  } catch {
    return null;
  }
}

// Returns the untruncated payloads that truncateField cut, gzipped, or null.
async function packFullData(item, record, fieldJson) {
  const parts = fullDataParts(item, record, fieldJson);
  return parts ? packParts(parts) : null;
}

// Counts a string held for full copies once, however many hold it, and
// returns the one instance they all share.
function holdString(text) {
  const held = heldStrings.get(text);
  if (held) { held.refs++; return held.text; }
  heldStrings.set(text, { text, refs: 1 });
  fullCandidateBytes += estimateBytes(text);
  return text;
}

function releaseString(text) {
  const held = heldStrings.get(text);
  if (!held || --held.refs > 0) return;
  heldStrings.delete(text);
  fullCandidateBytes -= estimateBytes(text);
}

// A queued save keeps what its full copy is made from: the packed copy an
// earlier save made of the same objects, or the JSON of its cut fields, never
// the body itself. Capped objects are held weakly, so nothing here keeps a
// body or an earlier packed copy alive.
function holdFull(entry, parts) {
  const prior = priorPack(parts);
  entry.full = prior
    ? { packed: holdString(prior), parts: null }
    : { packed: null, parts: parts.map(([key, json, capped]) => [key, holdString(json), new WeakRef(capped)]) };
  fullCandidates.push(entry);
  enforceFullBudget();
}

// Only the newest MAX_FULL_CANDIDATES saves keep theirs, within
// FULL_CANDIDATES_MAX_BYTES; the oldest go first.
function enforceFullBudget() {
  while (fullCandidates.length > 0
    && (fullCandidates.length > MAX_FULL_CANDIDATES || fullCandidateBytes > limits.fullCandidatesMaxBytes)) dropFull(fullCandidates.shift());
}

// Lets a save's strings go; pruneFullCandidates then takes it off the list.
function dropFull(entry) {
  const full = entry?.full;
  if (!full) return;
  entry.full = null;
  if (full.packed) releaseString(full.packed);
  for (const [, json] of full.parts ?? []) releaseString(json);
}

function pruneFullCandidates() {
  fullCandidates = fullCandidates.filter((entry) => entry.full);
}

// The JSON a queued save holds for this capped field: a stream's start save
// shares its request objects with its end save.
function jsonInWindow(capped) {
  for (let i = fullCandidates.length - 1; i >= 0; i--) {
    const part = fullCandidates[i].full?.parts?.find((p) => p[2].deref() === capped);
    if (part) return part[1];
  }
  return undefined;
}

// Two saves whose JSON is the same strings (held once each, so the same
// instances) pack to the same copy.
const sameParts = (a, b) => a.length === b.length && a.every(([key, json], i) => key === b[i][0] && json === b[i][1]);

// sql.js rewrites the whole DB file on every write, so it never stores full payloads.
const driverSkipsFullData = () => global._dbAdapter?.instance?.driver === "sql.js";

// Throws on a corrupt value so callers can tell it apart from a missing one.
async function unpackFullData(value) {
  if (!value) return null;
  return JSON.parse((await gunzipAsync(Buffer.from(value, "base64"))).toString("utf8"));
}

export const __test__ = { sanitizeHeaders, getMaxJsonSize, truncateField, prettyJsonPrefix, packFullData, unpackFullData, limits, MAX_FULL_CANDIDATES, MAX_ROWS_PER_WRITE,
  buffered: () => writeBuffer.length, queuedBytes: () => queuedBytes, inFlightBytes: () => inFlightBytes,
  fullCandidates: () => fullCandidates.length, fullCandidateBytes: () => fullCandidateBytes,
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
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_RECORDS_LIMIT) : DEFAULT_MAX_RECORDS;
}

// A save as it waits to be written: the columns and the capped record as JSON,
// built now so the save holds no body. A save whose fields were cut and that
// may get a full copy also gets the parts to pack, which holdFull keeps
// (entry.full) until newer saves push it out of fullCandidates or it is written.
function queueEntry(item, { maxJsonSize, keepFullData }) {
  if (!item.id) item.id = generateDetailId(item.model);
  if (!item.timestamp) item.timestamp = new Date().toISOString();
  if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);
  // A binary upstream body (Windsurf's protobuf starts with the API key) is
  // stored as its size only.
  for (const key of PAYLOAD_KEYS) if (isBinaryBody(item[key])) item[key] = binaryBodyMarker(item[key]);

  const fullCopy = keepFullData === true && !driverSkipsFullData();
  const fieldJson = fullCopy ? {} : undefined;
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
  const data = stringifyJson(record);
  const entry = {
    id: record.id, timestamp: record.timestamp, provider: record.provider, model: record.model,
    connectionId: record.connectionId, status: record.status, data, bytes: estimateBytes(data),
    keepFullData: fullCopy, full: null,
  };
  return { entry, parts: fullCopy && cut ? fullDataParts(item, record, fieldJson, jsonInWindow) : null };
}

// A queued record cut down when the queue is over its byte budget: the row,
// its status, tokens, latency and error stay; each payload over
// DEGRADED_PREVIEW_CHARS becomes a preview of that length.
function degradeRecord(data) {
  const record = JSON.parse(data);
  for (const key of PAYLOAD_KEYS) {
    const value = record[key];
    if (value == null) continue;
    const capped = typeof value === "object" && value._truncated === true;
    const text = capped ? String(value._preview ?? "") : typeof value === "string" ? value : JSON.stringify(value) ?? "";
    if (!capped && text.length <= DEGRADED_PREVIEW_CHARS) continue;
    const originalSize = capped ? value._originalSize ?? null : text.length;
    const preview = text.slice(0, DEGRADED_PREVIEW_CHARS);
    record[key] = {
      _truncated: true,
      _originalSize: originalSize,
      _omittedSize: originalSize === null ? null : Math.max(0, originalSize - preview.length),
      _preview: preview,
      _structuredPreview: null,
    };
  }
  return stringifyJson(record);
}

// Keeps the queue within its bounds after a save:
// - at most SAVES_PER_ROW × maxRecords saves (older ones are rows the trim
//   would delete anyway), and no more than fit the byte budget degraded;
// - past the byte budget, a running write's records included, the oldest
//   records are cut down (degradeRecord). A cut-down row gets no full copy,
//   which would no longer match it.
// - if it is still over once all are cut down, the oldest saves go.
// The newest save always stays.
function fitQueue(maxRecords) {
  const budget = limits.queuedRecordsMaxBytes;
  const maxQueued = Math.max(1, Math.min(SAVES_PER_ROW * rowLimit(maxRecords), Math.floor(budget / DEGRADED_RECORD_MAX_BYTES)));
  if (writeBuffer.length > maxQueued) dropOldest(writeBuffer.length - maxQueued);
  while (queuedBytes + inFlightBytes > budget && degradedCount < writeBuffer.length) {
    const entry = writeBuffer[degradedCount++];
    const data = degradeRecord(entry.data);
    queuedBytes += estimateBytes(data) - entry.bytes;
    entry.data = data;
    entry.bytes = estimateBytes(data);
    dropFull(entry);
  }
  let drop = 0;
  let bytes = queuedBytes;
  while (drop < writeBuffer.length - 1 && bytes + inFlightBytes > budget) bytes -= writeBuffer[drop++].bytes;
  if (drop > 0) dropOldest(drop);
  pruneFullCandidates();
}

function dropOldest(count) {
  for (const dropped of writeBuffer.splice(0, count)) {
    queuedBytes -= dropped.bytes;
    dropFull(dropped);
  }
  degradedCount = Math.max(0, degradedCount - count);
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
      const entries = takeWrite();
      try {
        await writeEntries(entries);
      } finally {
        // Written or lost, these saves hold no JSON from here on.
        for (const entry of entries) dropFull(entry);
        pruneFullCandidates();
        inFlightBytes = 0;
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

// The next write's saves, oldest first: up to MAX_ROWS_PER_WRITE of them and
// writeMaxBytes of their records (always at least one).
function takeWrite() {
  let count = 0;
  let bytes = 0;
  while (count < writeBuffer.length && count < MAX_ROWS_PER_WRITE && (count === 0 || bytes + writeBuffer[count].bytes <= limits.writeMaxBytes)) {
    bytes += writeBuffer[count].bytes;
    count++;
  }
  queuedBytes -= bytes;
  inFlightBytes = bytes;
  degradedCount = Math.max(0, degradedCount - count);
  return writeBuffer.splice(0, count);
}

// The trim's order, for saves of distinct rows.
const newestFirst = (a, b) => {
  const [at, bt] = [String(a.timestamp), String(b.timestamp)];
  return at !== bt ? (at < bt ? 1 : -1) : a.id < b.id ? 1 : -1;
};

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
  const toPack = wantFull
    ? entries.filter((entry, i) => entry.keepFullData && lastSave.get(entry.id) === i && keeping.has(entry.id))
    : [];
  // Newest first: saves made meanwhile push the oldest out of fullCandidates.
  // A save with no full copy (nothing cut, too big, pushed out, cut down)
  // stores none, and clears the copy an earlier save of its row stored, which
  // no longer matches it. Saves with the same JSON (one body sent to several
  // keys) share one gzip and one copy. Once this write's new copies take what
  // full copies hold past FULL_CANDIDATES_MAX_BYTES, its older rows get none.
  const packed = new Map();
  const packs = [];
  let packBytes = 0;
  for (const entry of toPack.sort(newestFirst)) {
    if (shuttingDown) break;
    const held = entry.full;
    let copy = null;
    if (held && fullCandidateBytes + packBytes <= limits.fullCandidatesMaxBytes) {
      if (held.packed) {
        copy = held.packed;
      } else {
        let pack = packs.find((p) => sameParts(p.parts, held.parts));
        if (!pack) {
          pack = { parts: held.parts, copy: await packParts(held.parts) };
          packs.push(pack);
          if (pack.copy) packBytes += estimateBytes(pack.copy);
        }
        copy = pack.copy;
      }
    }
    packed.set(entry, copy);
  }
  writeRows(db, entries, packed, { wantFull, maxRecords, stale: generation !== configCache.generation });
}

// A row this write didn't pack (shutdown) keeps the full copy an earlier save
// stored; the trim clears it unless the row is among the newest. `stale`: the
// setting was turned off (and stored payloads cleared) while compression was
// awaited. Nothing awaits between that check and the transaction, so a clear
// can't slip in after it.
function writeRows(db, entries, packed, { wantFull, maxRecords, stale }) {
  const rows = entries.map((entry) => ({
    entry,
    fullData: stale ? null : packed.get(entry) ?? null,
    keepStored: wantFull && !stale && !packed.has(entry),
  }));

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

  const { entry, parts } = queueEntry(detail, config);
  writeBuffer.push(entry);
  queuedBytes += entry.bytes;
  // Saves pushed out of fullCandidates can't end up among the newest
  // FULL_DATA_KEEP_ROWS rows (a later save of the same row would be the one
  // packed), or are the oldest of several huge ones.
  if (parts) holdFull(entry, parts);
  fitQueue(config.maxRecords);

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
  for (const entry of fullCandidates) dropFull(entry);
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
