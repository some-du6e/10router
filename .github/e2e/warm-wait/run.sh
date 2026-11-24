#!/usr/bin/env bash
# Warm-key wait memory E2E. Run from a built app checkout:
#   run.sh <leg>   leg = base | pr
# Starts the mock upstream and a seeded 10router (`node custom-server.js`, the
# production entry, with probe.cjs preloaded), then drive.mjs puts WAITING
# requests into a warm-key wait and reports what each holds in the server. The
# pr leg also fails if they still hold their bodies outside the heap.
set -euo pipefail

LEG="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT_DIR:-$PWD/e2e-out}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"

PIDS=()
cleanup() { [ ${#PIDS[@]} -gt 0 ] && kill "${PIDS[@]}" 2>/dev/null; wait 2>/dev/null || true; }
trap cleanup EXIT

node "$HERE/mock-upstream.mjs" > "$OUT/mock.log" 2>&1 &
PIDS+=($!)
node --experimental-loader=./scripts/resolve-src-alias.mjs "$HERE/seed.mjs" 2>&1 | grep -v -i warning

# Each 429 after the first moves the warm key's lock a little later; a longer
# warm-wait budget keeps the last requests from running out of the default
# 10 s and going to the cold key.
PROBE_OUT="$OUT/probe.json" NODE_OPTIONS="--require $HERE/probe.cjs" CACHE_AFFINITY_MAX_WAIT_MS=30000 \
  JWT_SECRET="e2e-$(openssl rand -hex 16)" PORT=20128 HOSTNAME=127.0.0.1 \
  node custom-server.js --port 20128 > "$OUT/server.log" 2>&1 &
SERVER_PID=$!
PIDS+=("$SERVER_PID")

for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:20128/v1/models && break
  sleep 2
done
curl -sf -o /dev/null http://127.0.0.1:20128/v1/models || { echo "server did not start"; tail -50 "$OUT/server.log"; exit 1; }

echo "leg: $LEG"
EXPECT_RELEASED="$([ "$LEG" = pr ] && echo 1 || echo 0)" \
  node "$HERE/drive.mjs" "$SERVER_PID" "$OUT/server.log" "$OUT/probe.json" "$OUT/result-$LEG.json"
