// Drives a built 10router into a warm-key wait and measures what the waiting
// requests hold, inside the server (probe.cjs). Run by run.sh:
//   node drive.mjs <server pid> <server log> <probe file> <result.json>
// WAITING (default 40) concurrent requests, BODY_MESSAGES (default 220) long.
// EXPECT_RELEASED=1 fails the run when a waiting request still holds more
// than half a body outside the heap (encoded bytes, Next's copy of the body).
//
// 1. Each conversation's first turn, small, is served by the warm key.
// 2. Two throwaway requests, each 429'd on the warm key once its last lock is
//    over, take its backoff to level 2, so the next 429 locks it for 8 s.
// 3. WAITING big turns go to the warm key, which holds them until all have
//    arrived, then answers each with a 429. Each waits for it rather than
//    rebuild its prompt cache on the cold key.
// 4. With every request waiting, the probe runs full GCs in the server and
//    reports its memory, against the probe before step 3.
// 5. They resume on the warm key: each must be answered, none may reach the
//    cold key, and each resumed attempt must send the bytes its first one did.
import fs from "node:fs";
import { claudeCodeHeaders, conversation, WAIT_LINE } from "../../../tests/helpers/warmWait.js";

const [pid, logFile, probeFile, resultFile] = process.argv.slice(2);
const WAITING = Number(process.env.WAITING || 40);
const MESSAGES = Number(process.env.BODY_MESSAGES || 220);
const SERVER = "http://127.0.0.1:20128";
const MOCK = "http://127.0.0.1:9998";
const MB = 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const control = (msg) => fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(msg) }).then((r) => r.json());
const turn = (i, messages) => conversation(i, { model: "ww/kimi-k3", messages });

async function post(text) {
  const res = await fetch(`${SERVER}/v1/messages`, { method: "POST", headers: claudeCodeHeaders(), body: text });
  await res.text();
  return res.status;
}

let probes = 0;
async function probe() {
  probes += 1;
  process.kill(Number(pid), "SIGUSR2");
  for (let i = 0; i < 600; i++) {
    try {
      const m = JSON.parse(fs.readFileSync(probeFile, "utf8"));
      if (m.seq === probes) return m;
    } catch { /* not written yet */ }
    await sleep(10);
  }
  throw new Error("probe did not answer");
}

const waitLines = () => fs.readFileSync(logFile, "utf8").split(WAIT_LINE).length - 1;

async function main() {
  const warmup = await Promise.all(Array.from({ length: WAITING }, (_, i) => post(turn(i, 3))));
  if (!warmup.every((s) => s === 200)) throw new Error(`warm-up statuses ${warmup}`);
  for (const [i, lockMs] of [[0, 0], [1, 2000]]) {
    await sleep(lockMs + 500);
    await control({ limitNext: 1 });
    const status = await post(turn(10_000 + i, 3));
    if (status !== 200) throw new Error(`throwaway ${i}: ${status}`);
  }
  await sleep(4500);

  const before = await probe();
  const linesBefore = waitLines();
  await control({ barrier: WAITING });
  const pending = Array.from({ length: WAITING }, (_, i) => post(turn(i, MESSAGES)));
  for (let i = 0; waitLines() - linesBefore < WAITING; i++) {
    if (i > 6000) throw new Error(`only ${waitLines() - linesBefore} of ${WAITING} requests waited`);
    await sleep(10);
  }
  const during = await probe();
  const stateDuring = await control({});
  const statuses = await Promise.all(pending);
  const state = await control({});

  const waits = [...fs.readFileSync(logFile, "utf8").matchAll(/waiting (\d+)ms for a key holding/g)].slice(-WAITING).map((m) => Number(m[1]));
  const bodyMb = turn(0, MESSAGES).length / MB;
  const per = (key) => (during[key] - before[key]) / WAITING / MB;
  const result = {
    waiting: WAITING, bodyMb, node: process.version,
    heldMb: per("heapUsed") + per("external"), heapMb: per("heapUsed"), externalMb: per("external"), arrayBuffersMb: per("arrayBuffers"), rssMb: per("rss"),
    waitMs: { min: Math.min(...waits), max: Math.max(...waits) },
    allWaiting: stateDuring.resumed.length === 0,
    answered: statuses.every((s) => s === 200),
    cold: state.cold,
    sameBytes: state.resumed.length === WAITING && [...state.resumed].sort().join() === [...state.limited].sort().join(),
  };
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(`${WAITING} waiting, body ${bodyMb.toFixed(2)} MB each, server on ${process.version}`);
  console.log(`per waiting request: ${result.heldMb.toFixed(2)} MB (${(result.heldMb / bodyMb).toFixed(2)} bodies): heap ${result.heapMb.toFixed(2)} MB, external ${result.externalMb.toFixed(2)} MB (arrayBuffers ${result.arrayBuffersMb.toFixed(2)} MB), rss ${result.rssMb.toFixed(2)} MB`);
  console.log(`waits ${result.waitMs.min}-${result.waitMs.max} ms; all waiting at the probe: ${result.allWaiting}; answered: ${result.answered}; cold key requests: ${result.cold}; resumed with the same bytes: ${result.sameBytes}`);
  const failures = [];
  if (!result.allWaiting) failures.push("some requests resumed before the probe");
  if (!result.answered) failures.push(`statuses ${statuses}`);
  if (result.cold !== 0) failures.push(`${result.cold} requests reached the cold key`);
  if (!result.sameBytes) failures.push("a resumed attempt sent other bytes");
  if (process.env.EXPECT_RELEASED === "1" && result.arrayBuffersMb > bodyMb / 2) {
    failures.push(`each waiting request still holds ${result.arrayBuffersMb.toFixed(2)} MB of buffers, over half a body`);
  }
  if (failures.length) {
    console.log(`FAIL: ${failures.join("; ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
