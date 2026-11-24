#!/usr/bin/env bash
# Proxy overhead: gateway-bench against a plain-Node stand-in app server
# (gateway/bench/upstream.mjs), straight to it and through the gateway, which
# starts it the way it starts the real one. Prints Markdown. Run from the repo
# root with the two binaries built:
#   GATEWAY_BIN=... BENCH_BIN=... bench.sh
set -euo pipefail
: "${GATEWAY_BIN:?}" "${BENCH_BIN:?}"
OUT="${OUT_DIR:-$PWD/bench-out}"
mkdir -p "$OUT"

GATEWAY_MODE=proxy HOSTNAME=127.0.0.1 PORT=18080 GATEWAY_APP_PORT=18081 \
  "$GATEWAY_BIN" -- node gateway/bench/upstream.mjs > "$OUT/gateway.log" 2>&1 &
GW_PID=$!
trap 'kill "$GW_PID" 2> /dev/null' EXIT
for _ in $(seq 1 100); do
  curl -sf -o /dev/null http://127.0.0.1:18080/_gateway/health && break
  sleep 0.2
done
curl -sf -o /dev/null http://127.0.0.1:18080/_gateway/health || { cat "$OUT/gateway.log"; exit 1; }
APP_PID="$(pgrep -f '[g]ateway/bench/upstream.mjs')"

echo "### Proxy overhead"
echo
echo "$(nproc) vCPU runner, $(go version | cut -d' ' -f3), Node $(node --version). The bench client, the gateway and the app server share the runner."
echo
"$BENCH_BIN" -direct http://127.0.0.1:18081 -proxy http://127.0.0.1:18080 -gateway-pid "$GW_PID" -app-pid "$APP_PID" "$@"
echo
echo "Gateway RSS after the run: $(awk '/VmRSS/{print $2, $3}' "/proc/$GW_PID/status")."
