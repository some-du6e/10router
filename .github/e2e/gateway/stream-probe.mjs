// When does each event of a stream arrive? POSTs a JSON body and prints one
// JSON line: status, content type, when each `data:` line carrying text came
// (seconds from the start), and whether the stream ended with [DONE] or
// message_stop.
//   node stream-probe.mjs <url> <json body | @file> [api key]
import http from "node:http";
import { readFileSync } from "node:fs";

const [url, bodyArg, apiKey] = process.argv.slice(2);
const body = bodyArg.startsWith("@") ? readFileSync(bodyArg.slice(1)) : Buffer.from(bodyArg);
const started = Date.now();
const at = () => Number(((Date.now() - started) / 1000).toFixed(3));
const headers = { "content-type": "application/json", "content-length": body.length, "anthropic-version": "2023-06-01" };
if (apiKey) headers.authorization = `Bearer ${apiKey}`;

const req = http.request(url, { method: "POST", headers }, (res) => {
  const headersAt = at();
  const arrivals = [];
  let pending = "";
  let text = "";
  let raw = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    raw += chunk;
    pending += chunk;
    let i;
    while ((i = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      const m = line.match(/"(?:content|text)":"([^"]*)"/);
      if (line.startsWith("data:") && m && m[1]) {
        arrivals.push(at());
        text += m[1];
      }
    }
  });
  res.on("end", () => {
    // A JSON reply (stream: false) has no data: lines.
    if (!arrivals.length) text = (raw.match(/"(?:content|text)":"([^"]+)"/) || [])[1] || "";
    console.log(JSON.stringify({
      status: res.statusCode,
      contentType: res.headers["content-type"] || null,
      headersAtS: headersAt,
      arrivals,
      text,
      done: /data: \[DONE\]|event: message_stop/.test(raw),
      endS: at(),
      bytes: Buffer.byteLength(raw),
    }));
  });
  res.on("error", (e) => console.log(JSON.stringify({ error: e.message, atS: at() })));
});
req.on("error", (e) => console.log(JSON.stringify({ error: e.message, atS: at() })));
req.end(body);
