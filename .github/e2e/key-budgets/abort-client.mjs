// Streams POST /v1/messages and hangs up after N content deltas, before
// message_delta. Prints one JSON line: { status, deltas, sawMessageDelta }.
// Usage: KEY=... node abort-client.mjs <base> <model> <deltas>
const [base, model, want = "6"] = process.argv.slice(2);
const ac = new AbortController();
const out = { status: 0, deltas: 0, sawMessageDelta: false, aborted: false };
try {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    signal: ac.signal,
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": process.env.KEY },
    body: JSON.stringify({ model, max_tokens: 8000, stream: true, messages: [{ role: "user", content: "E2E_SLOW_STREAM: write a long story" }] }),
  });
  out.status = res.status;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (out.deltas < Number(want)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (ev.includes('"content_block_delta"')) out.deltas++;
      if (ev.includes('"message_delta"')) out.sawMessageDelta = true;
    }
  }
  out.aborted = true;
  ac.abort();
} catch (e) {
  if (e.name !== "AbortError") out.error = String(e.message || e);
}
console.log(JSON.stringify(out));
