#!/usr/bin/env bash
# Early-headers E2E. Run from a built app checkout:
#   run.sh <leg>   leg = master | pr
# Starts the mock upstream, 10router and a Cloudflare quick tunnel, then sends
# requests whose upstream holds its headers for HOLD_MS (150s), longer than
# Cloudflare's ~100s wait. master (pinned to before the fix) should 524; pr should answer.
set -uo pipefail

LEG="$1"
# shellcheck source=stack.sh
source "$(cd "$(dirname "$0")" && pwd)/stack.sh"

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

# 3. Real Codex CLI through Cloudflare, on a custom Responses provider whose
# key is the fake per-run 10router key. Each run gets its own CODEX_HOME so no
# real Codex login is ever read. retries=0 makes a 524 show once.
codex_run() { # name model retries
  local name="$1" home="$OUT/codex-home-$1"
  mkdir -p "$home"
  {
    echo "model = \"$2\""
    echo 'model_provider = "e2e"'
    echo 'approval_policy = "never"'
    echo 'sandbox_mode = "read-only"'
    echo '[model_providers.e2e]'
    echo 'name = "10router E2E"'
    echo "base_url = \"$TUNNEL/v1\""
    echo 'env_key = "E2E_CODEX_KEY"'
    echo 'wire_api = "responses"'
    echo 'stream_idle_timeout_ms = 300000'
    [ -n "$3" ] && echo "request_max_retries = $3" && echo "stream_max_retries = $3"
  } > "$home/config.toml"
  ( start=$(date +%s); CODEX_HOME="$home" E2E_CODEX_KEY="$E2E_API_KEY" \
      timeout 400 codex exec --skip-git-repo-check -C "$home" -o "$OUT/$name.last" "Reply with one word." \
      < /dev/null > "$OUT/$name.out" 2>&1
    echo "exit=$? time=$(( $(date +%s) - start ))s" > "$OUT/$name.meta" ) &
}
codex_run codex-slow mock/slow 0

if [ "$LEG" = "pr" ]; then
  # 3b. Codex, upstream fails after the headers went out: the in-band
  # response.failed must make Codex retry the stream (default retries), and
  # the retry answers.
  codex_run codex-flaky mock/flaky-codex ""

  # 4. curl, OpenAI chat format, through Cloudflare.
  ( curl -sS -N -o "$OUT/curl-chat.body" -w 'http=%{http_code} time=%{time_total}s\n' \
      -X POST "$TUNNEL/v1/chat/completions" -H 'content-type: application/json' -H "authorization: Bearer $E2E_API_KEY" \
      -d '{"model":"mock/slow","stream":true,"messages":[{"role":"user","content":"ping"}]}' > "$OUT/curl-chat.meta" 2>&1 ) &

  # 5. Claude Code, upstream fails after the headers went out: the in-band
  # overloaded_error must make Claude Code retry, and the retry answers.
  ( start=$(date +%s); ANTHROPIC_BASE_URL="$TUNNEL" \
      timeout 400 claude -p "Reply with one word." --model mock/flaky > "$OUT/claude-flaky.out" 2>&1
    echo "exit=$? time=$(( $(date +%s) - start ))s" > "$OUT/claude-flaky.meta" ) &

  # 6. Client hangs up while waiting (direct, so the hang-up timing is ours):
  # 10router must drop the upstream request, not leave it running for 150s.
  ( curl -sS -N -o "$OUT/curl-disconnect.body" --max-time 45 -w 'http=%{http_code} time=%{time_total}s\n' \
      -X POST http://127.0.0.1:20128/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
      -d "${MSG/mock\/slow/mock/slow-disconnect}" > "$OUT/curl-disconnect.meta" 2>&1 ) &
fi

# Wait for the request jobs only (mock, server and tunnel stay up).
# shellcheck disable=SC2046
wait_for curl-messages claude-slow codex-slow $( [ "$LEG" = pr ] && echo curl-chat claude-flaky codex-flaky curl-disconnect )
sleep 2

for f in "$OUT"/*.meta; do n=$(basename "$f" .meta); echo "== $n: $(cat "$f")"; done
show "curl /v1/messages body" "$OUT/curl-messages.body"
show "claude -p (slow)" "$OUT/claude-slow.out"
show "codex exec (slow)" "$OUT/codex-slow.out"
show "codex exec (slow) last message" "$OUT/codex-slow.last"
[ "$LEG" = pr ] && { show "curl /v1/chat/completions body" "$OUT/curl-chat.body"; show "claude -p (flaky)" "$OUT/claude-flaky.out"; show "codex exec (flaky)" "$OUT/codex-flaky.out"; show "codex exec (flaky) last message" "$OUT/codex-flaky.last"; show "curl disconnect" "$OUT/curl-disconnect.meta"; }
show "mock upstream log" "$OUT/mock.log"
grep -E 'early SSE|ERROR|✗' "$OUT/server.log" | head -40

if [ "$LEG" = master ]; then
  check "curl gets Cloudflare 524" "grep -q 'http=524' '$OUT/curl-messages.meta'"
  check "Claude Code fails with 524" "grep -q '524' '$OUT/claude-slow.out'"
  check "Codex fails with 524" "! grep -q 'exit=0' '$OUT/codex-slow.meta' && grep -q '524' '$OUT/codex-slow.out' && ! grep -qi 'pong' '$OUT/codex-slow.last' 2>/dev/null"
else
  check "curl /v1/messages gets 200" "grep -q 'http=200' '$OUT/curl-messages.meta'"
  check "curl /v1/messages body has keepalives then the answer" "grep -q '^: keepalive' '$OUT/curl-messages.body' && grep -q 'pong' '$OUT/curl-messages.body' && grep -q 'message_stop' '$OUT/curl-messages.body'"
  check "curl /v1/chat/completions gets the answer" "grep -q 'http=200' '$OUT/curl-chat.meta' && grep -q 'pong' '$OUT/curl-chat.body' && grep -q 'data: \[DONE\]' '$OUT/curl-chat.body'"
  check "Claude Code answers through the slow upstream" "grep -q 'exit=0' '$OUT/claude-slow.meta' && grep -qi 'pong' '$OUT/claude-slow.out'"
  check "Claude Code retries the in-band error and answers" "grep -q 'exit=0' '$OUT/claude-flaky.meta' && grep -qi 'pong' '$OUT/claude-flaky.out' && [ \$(grep -c '\"event\":\"request\".*\"model\":\"flaky\"' '$OUT/mock.log') -ge 2 ]"
  check "Codex answers through the slow upstream" "grep -q 'exit=0' '$OUT/codex-slow.meta' && grep -qi 'pong' '$OUT/codex-slow.last'"
  check "Codex retries the in-band response.failed and answers" "grep -q 'exit=0' '$OUT/codex-flaky.meta' && grep -qi 'pong' '$OUT/codex-flaky.last' && [ \$(grep -c '\"event\":\"request\".*\"model\":\"flaky-codex\"' '$OUT/mock.log') -ge 2 ]"
  check "client hang-up drops the upstream request" "grep -q '\"event\":\"closed-by-client\",\"model\":\"slow-disconnect\"' '$OUT/mock.log' && ! grep -q '\"event\":\"answered\",\"model\":\"slow-disconnect\"' '$OUT/mock.log'"
fi
exit $fail
