#!/usr/bin/env bash
# Codex over the Responses WebSocket transport, end to end, on a model served
# by a translated (Chat Completions) endpoint. Run from a built app checkout
# with `codex` and `cloudflared` on PATH:
#   run.sh <leg>   leg = master | pr
# The early-headers stack starts the mock upstream (mock/fast streams "pong"),
# a seeded 10router with a fake per-run client key, and a Cloudflare quick
# tunnel. Then the real Codex CLI runs on the built-in `openai` provider
# (websockets on, the default) with `openai_base_url` pointed at the app, once
# directly and once through the tunnel. master (pinned to before the fix) hangs
# through the tunnel; pr answers both ways.
set -uo pipefail

LEG="$1"
# shellcheck source=../early-headers/stack.sh
source "$(cd "$(dirname "$0")" && pwd)/../early-headers/stack.sh"
MODEL="mock/fast"

check "the tunnel answers health checks" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'x-api-key: $E2E_API_KEY' '$TUNNEL/v1/models')\" = 200 ]"

# Plain HTTP, the path that already worked.
curl -sS -N -o "$OUT/http.body" -w 'http=%{http_code} time=%{time_total}s\n' --max-time 60 \
  -X POST http://127.0.0.1:20128/backend-api/codex/responses -H 'content-type: application/json' -H "authorization: Bearer $E2E_API_KEY" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"input\":[{\"role\":\"user\",\"content\":\"ping\"}]}" > "$OUT/http.meta" 2>&1
check "HTTP SSE answers" "grep -q 'http=200' '$OUT/http.meta' && grep -q 'response.completed' '$OUT/http.body' && grep -q '\"delta\":\"pong\"' '$OUT/http.body'"

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
    timeout "${CODEX_TIMEOUT_S:-120}" codex exec --skip-git-repo-check -C "$home" -o "$OUT/$name.last" \
    -m "$MODEL" "Reply with one word." < /dev/null > "$OUT/$name.out" 2>&1
  echo "$?" > "$OUT/$name.code"
  echo "$name: exit=$(cat "$OUT/$name.code") time=$(( $(date +%s) - start ))s" | tee "$OUT/$name.meta"
  # The trace lines carry whole request bodies; keep only what tells the story.
  grep -oE 'connecting to websocket: [a-z]+://[^/]+|successfully connected to websocket|websocket event: \{"type":"[a-z_.]+"|stream closed before response.completed|websocket closed by server[^"]*|idle timeout[^"]*' \
    "$OUT/$name.out" | sed -E 's#(wss?://)[^/ ]+#\1<host>#' | head -80 > "$OUT/$name.trace"
  show "$name: codex WebSocket trace (event types)" "$OUT/$name.trace"
  show "$name: codex last message" "$OUT/$name.last"
}

# answered <name>: Codex connected over WebSocket, streamed to
# response.completed, exited 0 and said "pong".
answered() {
  [ "$(cat "$OUT/$1.code")" = 0 ] && grep -q 'connecting to websocket' "$OUT/$1.trace" \
    && grep -q 'websocket event: {"type":"response.completed"' "$OUT/$1.trace" && grep -qi 'pong' "$OUT/$1.last" 2>/dev/null
}

codex_ws codex-direct http://127.0.0.1:20128
codex_ws codex-tunnel "$TUNNEL"

show "mock upstream log" "$OUT/mock.log"
show "server log ([CodexWS] and requests)" <(grep -E 'CodexWS|ERROR|✗|▶' "$OUT/server.log" | head -60)
# Turn POSTs (the bridge's included): Codex sends tools, curl doesn't.
turns=$(grep -c "▶ POST $MODEL .* TOOL" "$OUT/server.log")
echo "turn POSTs in the server log: $turns"

check "Codex answers over the WebSocket transport (direct)" "answered codex-direct"
if [ "$LEG" = master ]; then
  # The bug's own signature: the socket opens and the turn reaches the
  # pipeline, but not one event comes back, until the client gives up.
  check "through the tunnel: the WebSocket connects" "grep -q 'successfully connected to websocket' '$OUT/codex-tunnel.trace'"
  check "through the tunnel: the turn's POST reaches the pipeline" "[ $turns -ge 2 ]"
  check "through the tunnel: no response.created ever arrives" "! grep -q 'websocket event: {\"type\":\"response' '$OUT/codex-tunnel.trace'"
  check "through the tunnel: Codex is still waiting when the timeout hits" "[ \"\$(cat '$OUT/codex-tunnel.code')\" = 124 ]"
else
  check "Codex answers over the WebSocket transport (through the tunnel)" "answered codex-tunnel"
fi
exit $fail
