// When does each byte of a non-streaming reply arrive? Straight to the server
// (no tunnel), asking for gzip as SDKs and Cloudflare do, so Next's compression
// is on the path. Prints one JSON line: status, encoding, when the first byte
// came, the longest gap between chunks, and the decoded body.
//   node flush-probe.mjs <url> <json body>
import http from "node:http";
import zlib from "node:zlib";

const [url, body] = process.argv.slice(2);
const started = Date.now();
const at = () => (Date.now() - started) / 1000;

const req = http.request(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json", "accept-encoding": "gzip", "anthropic-version": "2023-06-01" },
}, (res) => {
  const headersAt = at();
  const chunks = [];
  const times = [];
  res.on("data", (c) => { chunks.push(c); times.push(at()); });
  res.on("end", () => {
    const raw = Buffer.concat(chunks);
    const encoding = res.headers["content-encoding"] || "identity";
    let text = "";
    try { text = (encoding === "gzip" ? zlib.gunzipSync(raw) : raw).toString(); } catch (e) { text = `undecodable: ${e.message}`; }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* reported as parsed: null */ }
    const gaps = times.map((t, i) => t - (i ? times[i - 1] : 0));
    console.log(JSON.stringify({
      status: res.statusCode,
      headersAtS: headersAt,
      contentType: res.headers["content-type"],
      contentLength: res.headers["content-length"] ?? null,
      encoding,
      chunks: times.length,
      firstByteS: times[0] ?? null,
      maxGapS: Math.max(0, ...gaps.slice(1)),
      endS: at(),
      leadingWhitespace: (text.match(/^\s*/) || [""])[0].length,
      parsed: parsed !== null,
      text: parsed?.content?.[0]?.text ?? null,
    }));
  });
});
req.on("error", (e) => console.log(JSON.stringify({ error: e.message, atS: at() })));
req.end(body);
