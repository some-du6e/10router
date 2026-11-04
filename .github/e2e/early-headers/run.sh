#!/usr/bin/env bash
# Early-headers E2E. Run from a built app checkout:
#   run.sh <leg>   leg = master | pr
# Starts the mock upstream, 10router and a Cloudflare quick tunnel, then sends
# requests whose upstream holds its headers for HOLD_MS (150s), longer than
# Cloudflare's ~100s wait. master should 524; pr should answer.
set -uo pipefail

LEG="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT_DIR:-$PWD/e2e-out}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
# Fake, per-run 10router key; the tunnel makes requests non-local.
export E2E_API_KEY="sk-e2e-$(openssl rand -hex 12)"

node "$HERE/mock-upstream.mjs" > "$OUT/mock.log" 2>&1 &
node --experimental-loader=./scripts/resolve-src-alias.mjs "$HERE/seed.mjs" 2>&1 | grep -v -i warning

# The upstream's own connect timeout (60s, retried) would end the wait before
# Cloudflare does; raise it so the only clock is Cloudflare's.
JWT_SECRET="e2e-$(openssl rand -hex 16)" FETCH_CONNECT_TIMEOUT_MS=300000 PORT=20128 HOSTNAME=127.0.0.1 \
  node custom-server.js --port 20128 > "$OUT/server.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:20128/v1/models && break
  sleep 2
done
curl -sf -o /dev/null http://127.0.0.1:20128/v1/models || { echo "server did not start"; tail -50 "$OUT/server.log"; exit 1; }

cloudflared tunnel --no-autoupdate --url http://127.0.0.1:20128 > "$OUT/cloudflared.log" 2>&1 &
TUNNEL=""
for _ in $(seq 1 60); do
  TUNNEL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$OUT/cloudflared.log" | head -1)"
  [ -n "$TUNNEL" ] && break
  sleep 2
done
[ -n "$TUNNEL" ] || { echo "no tunnel URL"; cat "$OUT/cloudflared.log"; exit 1; }
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $E2E_API_KEY" "$TUNNEL/v1/models")" = "200" ] && break
  sleep 3
done
echo "tunnel: $TUNNEL"

MSG='{"model":"mock/slow","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"ping"}]}'

# 1. curl, Claude Messages format, through Cloudflare.
( curl -sS -N -o "$OUT/curl-messages.body" -w 'http=%{http_code} time=%{time_total}s\n' \
    -X POST "$TUNNEL/v1/messages" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H "x-api-key: $E2E_API_KEY" \
    -d "$MSG" > "$OUT/curl-messages.meta" 2>&1 ) &

# 2. Real Claude Code through Cloudflare. No retries, so a 524 shows once
# instead of after ten more 100s waits.
export ANTHROPIC_API_KEY="$E2E_API_KEY" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
export ANTHROPIC_DEFAULT_HAIKU_MODEL="mock/fast" ANTHROPIC_SMALL_FAST_MODEL="mock/fast"
( start=$(date +%s); ANTHROPIC_BASE_URL="$TUNNEL" CLAUDE_CODE_MAX_RETRIES=0 \
    timeout 400 claude -p "Reply with one word." --model mock/slow > "$OUT/claude-slow.out" 2>&1
  echo "exit=$? time=$(( $(date +%s) - start ))s" > "$OUT/claude-slow.meta" ) &

if [ "$LEG" = "pr" ]; then
  # 3. curl, OpenAI chat format, through Cloudflare.
  ( curl -sS -N -o "$OUT/curl-chat.body" -w 'http=%{http_code} time=%{time_total}s\n' \
      -X POST "$TUNNEL/v1/chat/completions" -H 'content-type: application/json' -H "authorization: Bearer $E2E_API_KEY" \
      -d '{"model":"mock/slow","stream":true,"messages":[{"role":"user","content":"ping"}]}' > "$OUT/curl-chat.meta" 2>&1 ) &

  # 4. Claude Code, upstream fails after the headers went out: the in-band
  # overloaded_error must make Claude Code retry, and the retry answers.
  ( start=$(date +%s); ANTHROPIC_BASE_URL="$TUNNEL" \
      timeout 400 claude -p "Reply with one word." --model mock/flaky > "$OUT/claude-flaky.out" 2>&1
    echo "exit=$? time=$(( $(date +%s) - start ))s" > "$OUT/claude-flaky.meta" ) &

  # 5. Client hangs up while waiting (direct, so the hang-up timing is ours):
  # 10router must drop the upstream request, not leave it running for 150s.
  ( curl -sS -N -o "$OUT/curl-disconnect.body" --max-time 45 -w 'http=%{http_code} time=%{time_total}s\n' \
      -X POST http://127.0.0.1:20128/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
      -d "${MSG/mock\/slow/mock/slow-disconnect}" > "$OUT/curl-disconnect.meta" 2>&1 ) &
fi

# Wait for the request jobs only (mock, server and tunnel stay up).
for _ in $(seq 1 100); do
  done_all=1
  for f in curl-messages claude-slow $( [ "$LEG" = pr ] && echo curl-chat claude-flaky curl-disconnect ); do
    [ -s "$OUT/$f.meta" ] || done_all=0
  done
  [ "$done_all" = 1 ] && break
  sleep 5
done
sleep 2

show() { echo "::group::$1"; cat "$2" 2>/dev/null; echo; echo "::endgroup::"; }
for f in "$OUT"/*.meta; do n=$(basename "$f" .meta); echo "== $n: $(cat "$f")"; done
show "curl /v1/messages body" "$OUT/curl-messages.body"
show "claude -p (slow)" "$OUT/claude-slow.out"
[ "$LEG" = pr ] && { show "curl /v1/chat/completions body" "$OUT/curl-chat.body"; show "claude -p (flaky)" "$OUT/claude-flaky.out"; show "curl disconnect" "$OUT/curl-disconnect.meta"; }
show "mock upstream log" "$OUT/mock.log"
grep -E 'early SSE|ERROR|✗' "$OUT/server.log" | head -40

fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
if [ "$LEG" = master ]; then
  check "curl gets Cloudflare 524" "grep -q 'http=524' '$OUT/curl-messages.meta'"
  check "Claude Code fails with 524" "grep -q '524' '$OUT/claude-slow.out'"
else
  check "curl /v1/messages gets 200" "grep -q 'http=200' '$OUT/curl-messages.meta'"
  check "curl /v1/messages body has keepalives then the answer" "grep -q '^: keepalive' '$OUT/curl-messages.body' && grep -q 'pong' '$OUT/curl-messages.body' && grep -q 'message_stop' '$OUT/curl-messages.body'"
  check "curl /v1/chat/completions gets the answer" "grep -q 'http=200' '$OUT/curl-chat.meta' && grep -q 'pong' '$OUT/curl-chat.body' && grep -q 'data: \[DONE\]' '$OUT/curl-chat.body'"
  check "Claude Code answers through the slow upstream" "grep -q 'exit=0' '$OUT/claude-slow.meta' && grep -qi 'pong' '$OUT/claude-slow.out'"
  check "Claude Code retries the in-band error and answers" "grep -q 'exit=0' '$OUT/claude-flaky.meta' && grep -qi 'pong' '$OUT/claude-flaky.out' && [ \$(grep -c '\"event\":\"request\".*\"model\":\"flaky\"' '$OUT/mock.log') -ge 2 ]"
  check "client hang-up drops the upstream request" "grep -q '\"event\":\"closed-by-client\",\"model\":\"slow-disconnect\"' '$OUT/mock.log' && ! grep -q '\"event\":\"answered\",\"model\":\"slow-disconnect\"' '$OUT/mock.log'"
fi
exit $fail
