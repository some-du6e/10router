// Drives the shadow E2E (shadow.sh): the claudeprep corpus's Claude Code and
// SDK requests, routed to the seeded node ("sh/<model>") and to its combos,
// sent to the gateway on 127.0.0.1 (a local client, so no key). Prints one
// JSON summary: how many were sent and each status Node answered.
//   node shadow-drive.mjs <base URL>
import path from "node:path";

const base = process.argv[2] || "http://127.0.0.1:20128";
const { buildCorpus } = await import(path.join(process.cwd(), "tests/helpers/claudeprepCorpus.js"));

// Headers fetch sets itself, or that would describe another body.
const DROP = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]);

function requests() {
  const out = [];
  for (const f of buildCorpus()) {
    if (f.expectDecline || f.request.body === undefined) continue;
    let body;
    try {
      body = JSON.parse(f.request.body);
    } catch {
      continue;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const headers = Object.fromEntries(Object.entries(f.request.headers || {}).filter(([k]) => !DROP.has(k.toLowerCase())));
    out.push({ name: f.name, headers, body: { ...body, model: `sh/${f.inputs.model}` } });
  }
  // Combos (a fallback over two members, and one nested in another).
  const cc = out.find((r) => r.name.startsWith("cc-basic"));
  if (cc) {
    for (const combo of ["shadow-main", "shadow-outer"]) out.push({ name: `combo-${combo}`, headers: cc.headers, body: { ...cc.body, model: combo } });
  }
  return out;
}

const statuses = {};
const failures = [];
let sent = 0;
for (const r of requests()) {
  sent++;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { ...r.headers, "content-type": "application/json" },
      body: JSON.stringify(r.body),
      signal: AbortSignal.timeout(60_000),
    });
    await res.arrayBuffer();
    statuses[res.status] = (statuses[res.status] || 0) + 1;
    if (res.status >= 500) failures.push(`${r.name}: ${res.status}`);
  } catch (error) {
    failures.push(`${r.name}: ${error.message}`);
  }
}
console.log(JSON.stringify({ sent, statuses, failures: failures.slice(0, 20) }));
