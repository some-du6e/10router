#!/usr/bin/env bash
# Codex over the Responses WebSocket transport, end to end, on a model served
# by a translated (Chat Completions) custom endpoint. Run from a built app
# checkout with `codex` on PATH:
#   run.sh <expect>   expect = pass | fail
# Starts a stub Chat Completions upstream and 10router, registers the stub as a
# custom endpoint and makes a client key through the app's own APIs, then runs
# the real Codex CLI on the built-in `openai` provider (websockets on, the
# default) with `openai_base_url` pointed at the app. Every key is fake, made
# per run and masked.
set -uo pipefail

EXPECT="${1:-pass}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT_DIR:-$PWD/e2e-out}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
BASE=http://127.0.0.1:20128
PREFIX=acme
MODEL=claude-opus-5-5
export INITIAL_PASSWORD="e2e-pw-$(openssl rand -hex 8)"
echo "::add-mask::$INITIAL_PASSWORD"

fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
show() { echo "::group::$1"; cat "$2" 2>/dev/null; echo; echo "::endgroup::"; }
jget() { node -e 'try { const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((v, k) => v?.[k], o); console.log(v === undefined ? "" : String(v)); } catch { console.log(""); }' "$1" "$2"; }

# ---- Stack -------------------------------------------------------------------
node "$HERE/stub-upstream.mjs" > "$OUT/stub.log" 2>&1 &
JWT_SECRET="e2e-$(openssl rand -hex 16)" API_KEY_SECRET="e2e-$(openssl rand -hex 16)" MACHINE_ID_SALT=e2e-salt \
  PORT=20128 HOSTNAME=127.0.0.1 node custom-server.js --port 20128 > "$OUT/server.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE/api/health" && break; sleep 2; done
curl -sf -o /dev/null "$BASE/api/health" || { echo "server did not start"; tail -50 "$OUT/server.log"; exit 1; }

# ---- Endpoint, provider key and client key, through the app's APIs ------------
JAR="$OUT/jar"
login=$(curl -s -c "$JAR" -H 'content-type: application/json' -d "{\"password\":\"$INITIAL_PASSWORD\"}" "$BASE/api/auth/login" -o "$OUT/login.json" -w '%{http_code}')
node_code=$(curl -s -b "$JAR" -H 'content-type: application/json' \
  -d "{\"name\":\"Acme\",\"prefix\":\"$PREFIX\",\"type\":\"openai-compatible\",\"apiType\":\"chat\",\"baseUrl\":\"http://127.0.0.1:9998/v1\"}" \
  "$BASE/api/provider-nodes" -o "$OUT/node.json" -w '%{http_code}')
NODE_ID=$(jget "$OUT/node.json" node.id)
UPSTREAM_KEY="key-a-$(openssl rand -hex 8)"
echo "::add-mask::$UPSTREAM_KEY"
conn_code=$(curl -s -b "$JAR" -H 'content-type: application/json' \
  -d "{\"provider\":\"$NODE_ID\",\"apiKey\":\"$UPSTREAM_KEY\",\"name\":\"key-a\"}" \
  "$BASE/api/providers" -o "$OUT/connection.json" -w '%{http_code}')
key_code=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"name":"codex ws e2e"}' \
  "$BASE/api/keys" -o "$OUT/client-key.json" -w '%{http_code}')
CLIENT_KEY=$(jget "$OUT/client-key.json" key)
echo "::add-mask::$CLIENT_KEY"
: > "$OUT/client-key.json"
check "setup through the app's APIs (login, endpoint, provider key, client key)" \
  "[ '$login' = 200 ] && [ '$node_code' = 201 ] && [ -n '$NODE_ID' ] && [ '$conn_code' -ge 200 ] && [ '$conn_code' -lt 300 ] && [ -n '$CLIENT_KEY' ]"
echo "login=$login node=$node_code connection=$conn_code key=$key_code"

# ---- Plain HTTP, the path that already worked --------------------------------
curl -sS -N -o "$OUT/http.body" -w 'http=%{http_code} time=%{time_total}s\n' --max-time 60 \
  -X POST "$BASE/backend-api/codex/responses" -H 'content-type: application/json' -H "authorization: Bearer $CLIENT_KEY" \
  -d "{\"model\":\"$PREFIX/$MODEL\",\"stream\":true,\"input\":[{\"role\":\"user\",\"content\":\"reply with just: ok\"}]}" > "$OUT/http.meta" 2>&1
check "HTTP SSE answers" "grep -q 'http=200' '$OUT/http.meta' && grep -q 'response.completed' '$OUT/http.body' && grep -q '\"delta\":\"ok\"' '$OUT/http.body'"

# ---- Real Codex CLI, WebSocket transport ------------------------------------
CODEX_HOME_DIR="$(mktemp -d)"
{
  echo "openai_base_url = \"$BASE/backend-api/codex\""
  echo "model = \"$PREFIX/$MODEL\""
  echo 'approval_policy = "never"'
  echo 'sandbox_mode = "read-only"'
} > "$CODEX_HOME_DIR/config.toml"
start=$(date +%s)
CODEX_HOME="$CODEX_HOME_DIR" CODEX_API_KEY="$CLIENT_KEY" RUST_LOG="codex_api::endpoint::responses_websocket=trace,codex_core::client=debug" \
  timeout "${CODEX_TIMEOUT_S:-120}" codex exec --skip-git-repo-check -C "$CODEX_HOME_DIR" -o "$OUT/codex.last" \
  -m "$PREFIX/$MODEL" "reply with just: ok" < /dev/null > "$OUT/codex.out" 2>&1
code=$?
echo "codex exit=$code time=$(( $(date +%s) - start ))s" | tee "$OUT/codex.meta"
# Uploaded artifacts are not masked like the job log, so scrub the fake keys.
sed -i -e "s/$CLIENT_KEY/[client-key]/g" -e "s/$UPSTREAM_KEY/[upstream-key]/g" "$OUT/codex.out" "$OUT/server.log"

# The trace lines carry whole request bodies; keep only what tells the story.
grep -oE 'connecting to websocket[^,]*|successfully connected to websocket|websocket event: \{"type":"[a-z_.]+"|stream closed before response.completed|websocket closed by server[^"]*|falling back to HTTP[^"]*|idle timeout[^"]*' "$OUT/codex.out" | head -80 > "$OUT/codex-ws.trace"
show "codex WebSocket trace (event types)" "$OUT/codex-ws.trace"
show "codex last message" "$OUT/codex.last"
show "stub upstream log" "$OUT/stub.log"
show "server log ([CodexWS] and errors)" <(grep -E 'CodexWS|ERROR|✗|▶' "$OUT/server.log" | head -60)

passed=0
grep -q 'connecting to websocket' "$OUT/codex.out" && grep -q 'websocket event: {"type":"response.completed"' "$OUT/codex.out" \
  && [ "$code" = 0 ] && grep -qi 'ok' "$OUT/codex.last" 2>/dev/null && passed=1
if [ "$EXPECT" = pass ]; then
  check "Codex answers over the WebSocket transport" "[ $passed = 1 ]"
else
  check "Codex does not get an answer over the WebSocket transport (the bug)" "[ $passed = 0 ]"
fi
exit $fail
