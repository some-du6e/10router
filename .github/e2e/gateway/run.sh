#!/usr/bin/env bash
# Go gateway E2E on the built image. The same seeded database and the same
# checks, twice: as shipped (GATEWAY_MODE unset: Node alone on 20128) and with
# GATEWAY_MODE=proxy (the gateway on 20128, Node on loopback 20129). Each leg
# ends with a graceful stop in the middle of a stream. Run from a checkout with
# root deps installed (for the seed) and the image built:
#   IMAGE=10router:e2e run.sh
# Uses the early-headers mock upstream and seed: mock/fast answers "pong",
# mock/drip<N> streams N chunks 400 ms apart. Requests to this runner's own
# non-loopback address are remote (they need the seeded key); requests to
# 127.0.0.1 are local.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SHARED="$HERE/../early-headers"
OUT="${OUT_DIR:-$PWD/e2e-out}"
IMAGE="${IMAGE:-10router:e2e}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
export E2E_API_KEY="${E2E_API_KEY:-sk-e2e-$(openssl rand -hex 12)}"
HOST_IP="$(hostname -I | awk '{print $1}')"
[ -n "$HOST_IP" ] || { echo "no non-loopback address"; exit 1; }
LOCAL=http://127.0.0.1:20128
REMOTE="http://$HOST_IP:20128"

fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
show() { echo "::group::$1"; cat "$2" 2>/dev/null; echo; echo "::endgroup::"; }
code_of() { curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$@"; }
json() { node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$1"; }
cleanup() {
  docker rm -f gw-e2e > /dev/null 2>&1
  kill $(jobs -p) 2> /dev/null
}
trap cleanup EXIT

# ---- Upstream and database ---------------------------------------------------
node "$SHARED/mock-upstream.mjs" > "$OUT/mock.log" 2>&1 &
node --experimental-loader=./scripts/resolve-src-alias.mjs "$SHARED/seed.mjs" > "$OUT/seed.log" 2>&1 \
  || { echo "seed failed"; cat "$OUT/seed.log"; exit 1; }
grep -v -i warning "$OUT/seed.log"
node -e 'process.stdout.write(JSON.stringify({model:"mock/fast",stream:false,messages:[{role:"user",content:"x".repeat(4*1024*1024)}]}))' > "$OUT/big.json"

start() { # start <leg> [GATEWAY_MODE]
  docker rm -f gw-e2e > /dev/null 2>&1
  docker run -d --name gw-e2e --network host \
    -v "$DATA_DIR:/app/data" -e DATA_DIR=/app/data \
    -e JWT_SECRET="e2e-$(openssl rand -hex 16)" -e PORT=20128 -e HOSTNAME=0.0.0.0 \
    -e SHUTDOWN_DRAIN_TIMEOUT_MS=60000 ${2:+-e GATEWAY_MODE=$2} "$IMAGE" > /dev/null
  for _ in $(seq 1 90); do [ "$(code_of "$LOCAL/v1/models")" = 200 ] && return 0; sleep 2; done
  echo "the $1 container did not answer"; docker logs gw-e2e 2>&1 | tail -80; return 1
}

legs() { # legs <leg> [GATEWAY_MODE]
  local leg="$1" mode="${2:-}" o="$OUT/$1"
  echo "::group::$leg: start (GATEWAY_MODE=${mode:-unset})"
  start "$leg" "$mode" || { fail=1; echo "::endgroup::"; return; }
  echo "::endgroup::"
  docker exec gw-e2e ps -o pid,args > "$o.ps" 2>&1
  show "$leg: processes" "$o.ps"
  if [ -n "$mode" ]; then
    check "$leg: the gateway is PID 1 and runs node as its child" \
      "awk '\$1==1' '$o.ps' | grep -q 10router-gateway && awk '\$1!=1 && \$2==\"node\" && \$3==\"custom-server.js\"' '$o.ps' | grep -q ."
    check "$leg: health endpoint answers" "curl -sf $LOCAL/_gateway/health | grep -q '\"status\":\"ok\"'"
    check "$leg: Node's loopback port is not reachable from outside" "[ \"\$(code_of http://$HOST_IP:20129/v1/models)\" = 000 ]"
  else
    check "$leg: node is PID 1, no gateway running" "awk '\$1==1 && \$2==\"node\" && \$3==\"custom-server.js\"' '$o.ps' | grep -q . && ! grep -q 10router-gateway '$o.ps'"
    check "$leg: no gateway health endpoint" "! curl -s $LOCAL/_gateway/health | grep -q '\"mode\"'"
  fi

  # Who the request comes from.
  check "$leg: local client needs no key" "[ \"\$(code_of $LOCAL/v1/models)\" = 200 ]"
  check "$leg: remote client without a key is refused" "[ \"\$(code_of $REMOTE/v1/models)\" = 401 ]"
  check "$leg: remote client with the key is served" "[ \"\$(code_of -H 'x-api-key: $E2E_API_KEY' $REMOTE/v1/models)\" = 200 ]"
  check "$leg: remote client can't claim loopback with forwarding headers" \
    "[ \"\$(code_of -H 'X-Forwarded-For: 127.0.0.1' -H 'X-Real-IP: 127.0.0.1' -H 'Host: localhost' $REMOTE/v1/models)\" = 401 ]"

  # The hot-path shape: Anthropic messages, streamed.
  node "$HERE/stream-probe.mjs" "$REMOTE/v1/messages" \
    '{"model":"mock/fast","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"ping"}]}' "$E2E_API_KEY" > "$o.stream.json"
  show "$leg: /v1/messages stream" "$o.stream.json"
  check "$leg: /v1/messages streams pong to message_stop" \
    "[ \"\$(json status < '$o.stream.json')\" = 200 ] && json contentType < '$o.stream.json' | grep -q text/event-stream && [ \"\$(json text < '$o.stream.json')\" = pong ] && [ \"\$(json done < '$o.stream.json')\" = true ]"
  curl -s -N --max-time 30 -X POST "$REMOTE/v1/messages" -H 'content-type: application/json' -H "x-api-key: $E2E_API_KEY" -H 'anthropic-version: 2023-06-01' \
    -d '{"model":"mock/fast","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"ping"}]}' > "$o.stream.raw"
  # The stream with its generated ids and times taken out, for the legs to compare.
  sed -E 's/"(id|created|created_at)":("[^"]*"|[0-9]+)/"\1":_/g; s/msg_[A-Za-z0-9_-]+/msg_/g' "$o.stream.raw" > "$o.stream.norm"

  # Each event reaches the client when it is sent.
  node "$HERE/stream-probe.mjs" "$REMOTE/v1/chat/completions" \
    '{"model":"mock/drip6","stream":true,"messages":[{"role":"user","content":"ping"}]}' "$E2E_API_KEY" > "$o.drip.json"
  show "$leg: drip stream arrivals" "$o.drip.json"
  check "$leg: six chunks, each arriving on its own (>= 250 ms apart)" \
    "node -e 'const o=JSON.parse(require(\"fs\").readFileSync(\"$o.drip.json\",\"utf8\"));const a=o.arrivals;process.exit(o.status===200&&a.length===6&&a.every((t,i)=>i===0||t-a[i-1]>=0.25)?0:1)'"

  # A 4 MB body.
  node "$HERE/stream-probe.mjs" "$REMOTE/v1/chat/completions" "@$OUT/big.json" "$E2E_API_KEY" > "$o.big.json"
  show "$leg: 4 MB body" "$o.big.json"
  check "$leg: a 4 MB body is relayed" "[ \"\$(json status < '$o.big.json')\" = 200 ] && json text < '$o.big.json' | grep -q pong"

  # The Codex WebSocket bridge, locally and remotely with the key.
  node "$HERE/ws-probe.mjs" "$LOCAL" mock/fast > "$o.ws-local.json"
  node "$HERE/ws-probe.mjs" "$REMOTE" mock/fast "$E2E_API_KEY" > "$o.ws-remote.json"
  show "$leg: WebSocket (local)" "$o.ws-local.json"
  show "$leg: WebSocket (remote)" "$o.ws-remote.json"
  for w in local remote; do
    check "$leg: WebSocket turn ($w) completes with pong" \
      "[ \"\$(json status < '$o.ws-$w.json')\" = 101 ] && json events < '$o.ws-$w.json' | grep -q response.completed && json text < '$o.ws-$w.json' | grep -q pong"
  done
  node "$HERE/ws-probe.mjs" "$REMOTE" mock/fast > "$o.ws-nokey.json"
  show "$leg: WebSocket (remote, no key)" "$o.ws-nokey.json"
  check "$leg: WebSocket turn from a remote client without a key is not served" "! json text < '$o.ws-nokey.json' | grep -q pong"

  # The dashboard (the legs must agree; compared at the end).
  echo "$(code_of "$REMOTE/dashboard") $(code_of "$REMOTE/login") $(code_of "$LOCAL/dashboard")" > "$o.dashboard"
  check "$leg: dashboard pages answer ($(cat "$o.dashboard"))" "! grep -Eq '(^| )(000|5[0-9][0-9])( |$)' '$o.dashboard'"

  # A graceful stop in the middle of a stream (8 s of chunks).
  node "$HERE/stream-probe.mjs" "$REMOTE/v1/chat/completions" \
    '{"model":"mock/drip20","stream":true,"messages":[{"role":"user","content":"ping"}]}' "$E2E_API_KEY" > "$o.drain.json" &
  local probe=$!
  sleep 2
  local t0=$SECONDS
  docker stop -t 90 gw-e2e > /dev/null &
  local stopper=$!
  sleep 1
  echo "$(code_of "$LOCAL/v1/models")" > "$o.during-drain"
  wait "$probe"
  wait "$stopper"
  local took=$((SECONDS - t0))
  docker logs gw-e2e > "$o.log" 2>&1
  docker inspect -f '{{.State.ExitCode}}' gw-e2e > "$o.exit"
  show "$leg: stream across the stop" "$o.drain.json"
  show "$leg: shutdown lines" <(grep -E '\[(Shutdown|Gateway|Exit)\]' "$o.log")
  check "$leg: the in-flight stream finished across the stop" \
    "node -e 'const o=JSON.parse(require(\"fs\").readFileSync(\"$o.drain.json\",\"utf8\"));process.exit(o.status===200&&o.arrivals.length===20&&o.done?0:1)'"
  check "$leg: a request during the drain is not served ($(cat "$o.during-drain"))" "! grep -qx 200 '$o.during-drain'"
  check "$leg: the container exited 0 after draining (${took}s)" "grep -qx 0 '$o.exit' && [ $took -lt 60 ]"
  check "$leg: Node drained" "grep -q '\[Shutdown\] drained' '$o.log'"
  if [ -n "$mode" ]; then
    check "$leg: the gateway drained alongside" "grep -q '\[Gateway\] SIGTERM: draining' '$o.log' && grep -q '\[Gateway\] drained in' '$o.log'"
  fi
  docker rm -f gw-e2e > /dev/null 2>&1
}

legs off
legs proxy proxy

check "both legs stream the same bytes (ids and times aside)" "cmp -s '$OUT/off.stream.norm' '$OUT/proxy.stream.norm'"
check "both legs answer the dashboard the same ($(cat "$OUT/off.dashboard") / $(cat "$OUT/proxy.dashboard"))" "cmp -s '$OUT/off.dashboard' '$OUT/proxy.dashboard'"
if ! cmp -s "$OUT/off.stream.norm" "$OUT/proxy.stream.norm"; then
  diff "$OUT/off.stream.norm" "$OUT/proxy.stream.norm" | head -40
fi
show "mock upstream log" "$OUT/mock.log"
exit "$fail"
