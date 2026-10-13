// Real Codex CLI smoke test with an isolated Next server, DB and CODEX_HOME.
// Run from the repository root: node tests/integration/codex-fast-fail.mjs
// Add --keep-server to leave the dashboard and mock upstream running.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
const testDir = await mkdtemp(join(tmpdir(), "10router-codex-fast-fail-"));
const codexHome = join(testDir, "codex-home");
await mkdir(codexHome);
const port = Number(process.env.FAST_FAIL_TEST_PORT || 20138);
const baseUrl = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString("hex");
const counts = new Map();
const results = [];
let cookie = "";
let next;
let passed = false;

function stopServers() {
  next?.kill("SIGTERM");
  upstream.closeAllConnections();
  upstream.close();
}

const upstream = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const model = body.model || "unknown";
  counts.set(model, (counts.get(model) || 0) + 1);
  if (model.startsWith("error") || model.startsWith("limited") || (model === "account-success" && counts.get(model) === 1)) {
    response.writeHead(model.startsWith("limited") || model === "account-success" ? 429 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Deliberate upstream failure for retry test" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const resp = { id: "resp_smoke", object: "response", created_at: Math.floor(Date.now() / 1000), model, output: [] };
  let sequence = 0;
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  event("response.created", { response: { ...resp, status: "in_progress" } });
  const item = { id: "msg_smoke", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "OK" });
  if (model === "broken" && counts.get(model) === 1) {
    setTimeout(() => response.destroy(), 50);
    return;
  }
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "OK" });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { ...resp, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } });
  response.end();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { stopServers(); process.exit(0); });
}

async function api(path, body, method = "POST") {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  assert(response.ok, `${path}: ${response.status} ${JSON.stringify(json)}`);
  if (path === "/api/auth/login") cookie = response.headers.get("set-cookie").split(";")[0];
  return json;
}

async function runCodex(label, model, expectSuccess, expectedRequests, expectReconnect = false) {
  const started = Date.now();
  const before = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const child = spawn("codex", ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--json", "--sandbox", "read-only", "-m", model, "Reply only with OK. Do not use tools."], {
    cwd: testDir, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
  const code = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", resolveExit);
  });
  clearTimeout(timer);
  await writeFile(join(testDir, `${label}.jsonl`), stdout);
  await writeFile(join(testDir, `${label}.stderr`), stderr);
  assert(Number.isInteger(code), `${label}: Codex did not exit before the timeout`);
  assert.equal(code === 0, expectSuccess, `${label}: unexpected exit ${code}\n${stdout}\n${stderr}`);
  const reconnected = /reconnecting/i.test(stdout + stderr);
  assert.equal(reconnected, expectReconnect, `${label}: unexpected reconnect behavior\n${stdout}\n${stderr}`);
  if (expectSuccess) assert(stdout.includes('"text":"OK"'), `${label}: no assistant output\n${stdout}`);
  else {
    const failure = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === "turn.failed");
    assert(failure, `${label}: no terminal failure\n${stdout}`);
    assert(!failure.error?.message?.startsWith("{"), `${label}: error displayed raw JSON instead of its message\n${stdout}`);
  }
  const attempts = [...counts.values()].reduce((sum, count) => sum + count, 0) - before;
  assert.equal(attempts, expectedRequests, `${label}: unexpected upstream attempts`);
  const result = { label, elapsedMs: Date.now() - started, upstreamRequests: attempts, reconnected, exitCode: code };
  results.push(result);
  console.log(JSON.stringify(result));
}

try {
  await new Promise((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const log = createWriteStream(join(testDir, "server.log"));
  next = spawn(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, DATA_DIR: join(testDir, "data"), CODEX_HOME: codexHome, INITIAL_PASSWORD: password, NEXT_PUBLIC_BASE_URL: baseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout.pipe(log);
  next.stderr.pipe(log);
  console.log(`Starting isolated server at ${baseUrl}; test files: ${testDir}`);
  const deadline = Date.now() + 120000;
  while (true) {
    assert(next.exitCode === null, "Next server exited; check server.log");
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`, { signal: AbortSignal.timeout(10000) });
      if (response.ok) break;
    } catch { /* wait for compilation */ }
    assert(Date.now() < deadline, "Server startup timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  await api("/api/auth/login", { password });
  await api("/api/settings", { requireApiKey: false, rtkEnabled: false }, "PATCH");
  const { node } = await api("/api/provider-nodes", { name: "Retry smoke upstream", prefix: "smoke", apiType: "responses", baseUrl: upstreamUrl });
  for (const name of ["First account", "Second account"]) {
    await api("/api/providers", { provider: node.id, apiKey: `test-${name}`, name });
  }
  await writeFile(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "local-test-only" }), { mode: 0o600 });
  // No retry overrides in this first config: prove the gateway stops normal Codex retries.
  await writeFile(join(codexHome, "config.toml"), `model = "smoke/success"\nmodel_provider = "10router"\n[model_providers.10router]\nname = "10router"\nbase_url = "${baseUrl}/v1"\nwire_api = "responses"\n`);
  // Warm compilation before measuring the CLI runs.
  const warm = await fetch(`${baseUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "smoke/warmup", input: "OK", stream: true }) });
  assert(warm.ok);
  await warm.text();
  console.log("Testing terminal errors with Codex's default retry limits...");
  await runCodex("http-429", "smoke/limited-429", false, 2);
  await runCodex("account-success", "smoke/account-success", true, 2);
  await api("/api/combos", { name: "smoke-all-fail", models: ["smoke/limited-combo-a", "smoke/limited-combo-b"] });
  await runCodex("combo-exhausted", "smoke-all-fail", false, 4);
  await api("/api/combos", { name: "smoke-fallback", models: ["smoke/limited-combo", "smoke/success"] });
  await runCodex("combo-success", "smoke-fallback", true, 3);
  assert.equal(counts.get("limited-combo"), 2, "Failed model should try both accounts before fallback");
  assert.equal(counts.get("success"), 1, "Combo should reach the working model");
  console.log("Checking that interrupted streams still retry...");
  await runCodex("broken-stream-recovery", "smoke/broken", true, 2, true);
  // Temporary outages retain their retryable HTTP status for Codex.
  const transient = await fetch(`${baseUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "codex-tui" }, body: JSON.stringify({ model: "smoke/error-transient", input: "OK", stream: true }) });
  assert.equal(transient.status, 503);
  assert.equal(transient.headers.get("x-should-retry"), null);
  await transient.text();
  // Claude and generic clients retain normal limit responses.
  for (const [endpoint, agent] of [["messages", "claude-code"], ["responses", "generic-client"]]) {
    const response = await fetch(`${baseUrl}/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": agent }, body: JSON.stringify({ model: `smoke/limited-${endpoint}`, max_tokens: 16, input: "OK", messages: [{ role: "user", content: "OK" }], stream: true }) });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-should-retry"), null);
    assert(response.headers.has("retry-after"));
    await response.text();
  }
  await writeFile(join(testDir, "results.json"), JSON.stringify({ baseUrl, codexHome, results }, null, 2));
  console.log(`PASS. Results: ${join(testDir, "results.json")}`);
  passed = true;
  if (process.argv.includes("--keep-server")) {
    // The dashboard can be opened without logging in on this loopback-only test server.
    await api("/api/settings", { requireLogin: false }, "PATCH");
    console.log(`Server remains running at ${baseUrl}/dashboard/endpoint; CODEX_HOME=${codexHome}`);
    await new Promise(() => {});
  }
} finally {
  stopServers();
  if (!passed) console.error(`Test failed. Logs are in ${testDir}`);
}
