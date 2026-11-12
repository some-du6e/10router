#!/usr/bin/env bash
# Codex over the Responses WebSocket transport, end to end, on a model served
# by a translated (Chat Completions) endpoint. Run from a built app checkout
# with `codex` on PATH and E2E_API_KEY set (the workflow makes and masks it):
#   run.sh <leg>   leg = master | pr
# Uses the early-headers mock upstream (mock/fast streams "pong") and seed
# (a "mock" endpoint and the client key), starts 10router and proxy.mjs in
# front of it, then runs the real Codex CLI on the built-in `openai` provider
# (websockets on, the default) with `openai_base_url` pointed at the app: once
# directly and once through the proxy. master (pinned to before the fix) hangs
# through the proxy; pr answers both ways.
#
# Not stack.sh itself: it always opens a Cloudflare quick tunnel and exits
# without one, and quick-tunnel provisioning answered 429 to every attempt
# from CI. proxy.mjs does what that proxy did to the request instead.
set -uo pipefail

LEG="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
SHARED="$HERE/../early-headers"
OUT="${OUT_DIR:-$PWD/e2e-out}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
: "${E2E_API_KEY:?set E2E_API_KEY}"
APP=http://127.0.0.1:20128
PROXY=http://127.0.0.1:20129
MODEL="mock/fast"

show() { echo "::group::$1"; cat "$2" 2>/dev/null; echo; echo "::endgroup::"; }
fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
status_of() { curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H "x-api-key: $E2E_API_KEY" "$1"; }

# ---- Stack -------------------------------------------------------------------
node "$SHARED/mock-upstream.mjs" > "$OUT/mock.log" 2>&1 &
node --experimental-loader=./scripts/resolve-src-alias.mjs "$SHARED/seed.mjs" > "$OUT/seed.log" 2>&1 \
  || { echo "seed failed"; cat "$OUT/seed.log"; exit 1; }
grep -v -i warning "$OUT/seed.log"
JWT_SECRET="e2e-$(openssl rand -hex 16)" PORT=20128 HOSTNAME=127.0.0.1 node custom-server.js --port 20128 > "$OUT/server.log" 2>&1 &
node "$HERE/proxy.mjs" > "$OUT/proxy.log" 2>&1 &
for _ in $(seq 1 60); do [ "$(status_of "$APP/v1/models")" = 200 ] && break; sleep 2; done
[ "$(status_of "$APP/v1/models")" = 200 ] || { echo "server did not start"; tail -50 "$OUT/server.log"; exit 1; }
[ "$(status_of "$PROXY/v1/models")" = 200 ] || { echo "the proxy does not answer"; cat "$OUT/proxy.log"; exit 1; }

# Plain HTTP, the path that already worked.
curl -sS -N -o "$OUT/http.body" -w 'http=%{http_code} time=%{time_total}s\n' --max-time 60 \
  -X POST "$APP/backend-api/codex/responses" -H 'content-type: application/json' -H "authorization: Bearer $E2E_API_KEY" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"input\":[{\"role\":\"user\",\"content\":\"ping\"}]}" > "$OUT/http.meta" 2>&1
check "HTTP SSE answers" "grep -q 'http=200' '$OUT/http.meta' && grep -q 'response.completed' '$OUT/http.body' && grep -q '\"delta\":\"pong\"' '$OUT/http.body'"

# ---- Real Codex CLI, WebSocket transport ------------------------------------
# codex_ws <name> <app base URL>: one `codex exec` on a fresh CODEX_HOME.
# Leaves its exit code in <name>.code and the WebSocket story in <name>.trace.
codex_ws() {
  local name="$1" base="$2" home start
  home="$(mktemp -d)"
  {
    echo "openai_base_url = \"$base/backend-api/codex\""
    echo "model = \"$MODEL\""
    echo 'approval_policy = "never"'
    echo 'sandbox_mode = "read-only"'
  } > "$home/config.toml"
  start=$(date +%s)
  CODEX_HOME="$home" CODEX_API_KEY="$E2E_API_KEY" RUST_LOG="codex_api::endpoint::responses_websocket=trace" \
    timeout -k 10 "${CODEX_TIMEOUT_S:-120}" codex exec --skip-git-repo-check -C "$home" -o "$OUT/$name.last" \
    -m "$MODEL" "Reply with one word." < /dev/null > "$OUT/$name.out" 2>&1
  echo "$?" > "$OUT/$name.code"
  echo "$name: exit=$(cat "$OUT/$name.code") time=$(( $(date +%s) - start ))s" | tee "$OUT/$name.meta"
  # The trace lines carry whole request bodies; keep only what tells the story.
  grep -oE 'connecting to websocket: [a-z]+://[^ ,]+|successfully connected to websocket|websocket event: \{"type":"[a-z_.]+"|stream closed before response.completed|websocket closed by server[^"]*|idle timeout[^"]*' \
    "$OUT/$name.out" | head -80 > "$OUT/$name.trace"
  show "$name: codex WebSocket trace (event types)" "$OUT/$name.trace"
  show "$name: codex last message" "$OUT/$name.last"
}

# answered <name>: Codex connected over WebSocket, streamed to
# response.completed, exited 0 and said "pong".
answered() {
  [ "$(cat "$OUT/$1.code")" = 0 ] && grep -q 'connecting to websocket' "$OUT/$1.trace" \
    && grep -q 'websocket event: {"type":"response.completed"' "$OUT/$1.trace" && grep -qi 'pong' "$OUT/$1.last" 2>/dev/null
}

# Turn POSTs reaching the pipeline (the bridge's included; Codex sends tools,
# curl doesn't), and streamed upstream answers the mock gave with a 200.
turn_posts() { grep -c "▶ POST $MODEL .* TOOL" "$OUT/server.log"; }
answers_200() { grep -c '"event":"answered","model":"fast","stream":true,.*"status":200' "$OUT/mock.log"; }

codex_ws codex-direct "$APP"
posts_before=$(turn_posts)
answers_before=$(answers_200)
codex_ws codex-proxied "$PROXY"
posts_proxied=$(( $(turn_posts) - posts_before ))
answers_proxied=$(( $(answers_200) - answers_before ))

show "mock upstream log" "$OUT/mock.log"
show "proxy log" "$OUT/proxy.log"
show "server log ([CodexWS] and requests)" <(grep -E 'CodexWS|ERROR|✗|▶' "$OUT/server.log" | head -60)
echo "codex-proxied: $posts_proxied turn POST(s), $answers_proxied upstream answer(s) with 200"

check "Codex answers over the WebSocket transport (direct)" "answered codex-direct"
check "the proxy carried the WebSocket upgrades" "grep -q '\"kind\":\"upgrade\".*\"status\":101' '$OUT/proxy.log'"
if [ "$LEG" = master ]; then
  # The bug's own signature, so no other failure (a 5xx, a rejected turn, a
  # failing upstream) passes for it: the prewarm is declined, the turn's own
  # socket opens, its POST reaches the pipeline and the upstream answers it,
  # yet not one event comes back and nothing closes the socket, until the
  # client gives up.
  trace="$OUT/codex-proxied.trace"
  check "through the proxy: one error frame, the prewarm decline" "[ \$(grep -c 'websocket event: {\"type\":\"error\"' '$trace') = 1 ]"
  check "through the proxy: the turn's own WebSocket connects (after the decline)" \
    "sed -n '/websocket event: {\"type\":\"error\"/,\$p' '$trace' | sed 1d | grep -q 'successfully connected to websocket'"
  check "through the proxy: the turn's POST reaches the pipeline" "[ $posts_proxied -ge 1 ]"
  check "through the proxy: the upstream answers it with a 200" "[ $answers_proxied -ge 1 ]"
  check "through the proxy: no response event ever arrives" "! grep -q 'websocket event: {\"type\":\"response' '$trace'"
  check "through the proxy: the server never closes the socket" "! grep -q 'closed by server' '$trace'"
  check "through the proxy: Codex is still waiting when the timeout hits" "[ \"\$(cat '$OUT/codex-proxied.code')\" = 124 ]"
else
  check "Codex answers over the WebSocket transport (through the proxy)" "answered codex-proxied"
fi
exit $fail
