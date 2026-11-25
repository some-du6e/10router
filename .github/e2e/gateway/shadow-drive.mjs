// Drives the shadow E2E (shadow.sh): the claudeprep corpus's Claude Code and
// SDK requests, routed to the seeded nodes and combos (shadow-seed.mjs) and
// sent to the gateway on 127.0.0.1 (a local client). Every request goes to
// "sh/<model>"; every fourth also to "sht/<model>" (a providerThinking mode),
// every third with the budgeted key; plus the combos and a model the catalog
// gives a maxOutput. Prints one JSON summary: how many were sent and each
// status Node answered.
//   node shadow-drive.mjs <base URL>
import path from "node:path";

const base = process.argv[2] || "http://127.0.0.1:20128";
const { buildCorpus } = await import(path.join(process.cwd(), "tests/helpers/claudeprepCorpus.js"));
// shadow-seed.mjs's.
const CATALOG_MODEL = "zz-catalog-probe-1";
const BUDGET_KEY = "sk-shadow-budget";

// Headers fetch sets itself, or that would describe another body.
const DROP = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]);

function requests() {
  const corpus = [];
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
    corpus.push({ name: f.name, headers, body, model: f.inputs.model });
  }
  const out = [];
  corpus.forEach((r, i) => {
    const headers = i % 3 === 0 ? { ...r.headers, "x-api-key": BUDGET_KEY } : r.headers;
    out.push({ name: r.name, headers, body: { ...r.body, model: `sh/${r.model}` } });
    if (i % 4 === 0) out.push({ name: `${r.name} (thinking node)`, headers, body: { ...r.body, model: `sht/${r.model}` } });
  });
  const cc = corpus.find((r) => r.name.startsWith("cc-basic"));
  if (cc) {
    // Combos (a fallback over two members, and one nested in another).
    for (const combo of ["shadow-main", "shadow-outer"]) out.push({ name: `combo-${combo}`, headers: cc.headers, body: { ...cc.body, model: combo } });
    // Above the catalog's maxOutput, which Prepare clamps it to.
    out.push({ name: "catalog maxOutput", headers: cc.headers, body: { ...cc.body, model: `sh/${CATALOG_MODEL}`, max_tokens: 64000 } });
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
    if (res.status !== 200) failures.push(`${r.name}: ${res.status}`);
  } catch (error) {
    failures.push(`${r.name}: ${error.message}`);
  }
}
console.log(JSON.stringify({ sent, statuses, failures: failures.slice(0, 20) }));
