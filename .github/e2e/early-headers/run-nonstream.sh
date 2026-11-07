#!/usr/bin/env bash
# Non-streaming early-headers E2E. Run from a built app checkout:
#   SDK_DIR=<dir with @anthropic-ai/sdk and openai> run-nonstream.sh <leg>   leg = master | pr
# Real Anthropic and OpenAI SDK calls without streaming, and Claude Code's
# non-streaming fallback, through a Cloudflare quick tunnel to an upstream that
# takes longer than Cloudflare's ~100s wait. master should 524; pr should answer.
set -uo pipefail

LEG="$1"
# A short early delay, set the way an operator would (master ignores it).
export SERVER_ENV="NON_STREAM_EARLY_HEADERS_MS=10000"
# shellcheck source=stack.sh
source "$(cd "$(dirname "$0")" && pwd)/stack.sh"

sdk() { # name kind model [base]
  ( node "$HERE/sdk-client.mjs" "$2" "${4:-$TUNNEL}" "$3" > "$OUT/$1.out" 2>&1
    echo "exit=$?" > "$OUT/$1.meta" ) &
}

# 1-3. Each SDK, upstream holds the reply 150s.
sdk anthropic-slow anthropic mock/slow
sdk chat-slow chat mock/slow
sdk responses-slow responses mock/slow
# 4. The prod outage: first key hangs 92s then 500s, the second answers 40s later.
sdk anthropic-outage anthropic dual/outage

# 5. Real Claude Code: its stream comes back empty, so it retries without
# streaming (stream:false), and that reply takes 150s.
export ANTHROPIC_API_KEY="$E2E_API_KEY" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1
export ANTHROPIC_DEFAULT_HAIKU_MODEL="mock/fast" ANTHROPIC_SMALL_FAST_MODEL="mock/fast"
( start=$(date +%s); ANTHROPIC_BASE_URL="$TUNNEL" CLAUDE_CODE_MAX_RETRIES=0 \
    timeout 400 claude -p "Reply with one word." --model mock/hollow < /dev/null > "$OUT/claude-hollow.out" 2>&1
  echo "exit=$? time=$(( $(date +%s) - start ))s" > "$OUT/claude-hollow.meta" ) &

JOBS="anthropic-slow chat-slow responses-slow anthropic-outage claude-hollow"
if [ "$LEG" = "pr" ]; then
  # 6. Every key fails after the 200 went out: what each SDK gets.
  sdk anthropic-allfail anthropic dead/allfail
  sdk responses-allfail responses dead/allfail-r

  # 7. Bytes really leave the server while waiting, gzip included (no tunnel).
  ( node "$HERE/flush-probe.mjs" http://127.0.0.1:20128/v1/messages \
      '{"model":"mock/slow-probe","max_tokens":64,"stream":false,"messages":[{"role":"user","content":"ping"}]}' > "$OUT/flush.out" 2>&1
    echo "exit=$?" > "$OUT/flush.meta" ) &

  # 8. Client hangs up after the 200 went out: 10router drops the upstream request.
  ( curl -sS -o "$OUT/curl-disconnect.body" --max-time 30 -w 'http=%{http_code} time=%{time_total}s\n' \
      -X POST http://127.0.0.1:20128/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
      -d '{"model":"mock/slow-disconnect","max_tokens":64,"stream":false,"messages":[{"role":"user","content":"ping"}]}' > "$OUT/curl-disconnect.meta" 2>&1 ) &
  JOBS="$JOBS anthropic-allfail responses-allfail flush curl-disconnect"
fi

# shellcheck disable=SC2086
wait_for $JOBS
sleep 2

for n in $JOBS; do echo "== $n: $(cat "$OUT/$n.meta" 2>/dev/null) $(head -c 600 "$OUT/$n.out" 2>/dev/null)"; done
show "claude -p (hollow stream, non-streaming fallback)" "$OUT/claude-hollow.out"
show "mock upstream log" "$OUT/mock.log"
grep -E 'early (SSE|JSON)|ERROR|✗' "$OUT/server.log" | head -40

field() { node -e 'try { const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").pop()); console.log(String(process.argv[2].split(".").reduce((v, k) => v?.[k], o))); } catch { console.log("unreadable"); }' "$OUT/$1.out" "$2"; }
if [ "$LEG" = master ]; then
  for n in anthropic-slow chat-slow responses-slow anthropic-outage; do
    check "$n gets Cloudflare 524" "[ \"\$(field $n status)\" = 524 ]"
  done
  check "Claude Code's non-streaming fallback fails with 524" "grep -q '524' '$OUT/claude-hollow.out'"
else
  for n in anthropic-slow chat-slow responses-slow anthropic-outage; do
    check "$n answers through the slow upstream" "[ \"\$(field $n outcome)\" = reply ] && [ \"\$(field $n text)\" = pong ]"
  done
  check "the outage went through account fallback" "[ \$(grep -c '\"event\":\"request\".*\"model\":\"outage\"' '$OUT/mock.log') -ge 2 ]"
  check "Claude Code answers through its non-streaming fallback" "grep -q 'exit=0' '$OUT/claude-hollow.meta' && grep -qi 'pong' '$OUT/claude-hollow.out' && grep -q '\"model\":\"hollow\",\"stream\":false' '$OUT/mock.log'"
  check "Anthropic SDK gets the failure as an Anthropic error body" "[ \"\$(field anthropic-allfail outcome)\" = error-body ] && [ -n \"\$(field anthropic-allfail error.message)\" ]"
  check "OpenAI SDK gets the failure as a failed Response" "[ \"\$(field responses-allfail outcome)\" = error-body ] && [ \"\$(field responses-allfail status)\" = failed ]"
  check "early JSON headers at the delay, gzip or not" "[ \"\$(field flush status)\" = 200 ] && node -e 'process.exit(+process.argv[1] < 15 ? 0 : 1)' \"\$(field flush headersAtS)\""
  check "a byte at least every keepalive interval while waiting" "node -e 'process.exit(+process.argv[1] <= 20 ? 0 : 1)' \"\$(field flush maxGapS)\""
  check "the waited-for body parses after the whitespace" "[ \"\$(field flush parsed)\" = true ] && [ \"\$(field flush text)\" = pong ] && [ \"\$(field flush leadingWhitespace)\" -ge 2 ]"
  check "client hang-up drops the upstream request" "grep -q '\"event\":\"closed-by-client\",\"model\":\"slow-disconnect\"' '$OUT/mock.log' && ! grep -q '\"event\":\"answered\",\"model\":\"slow-disconnect\"' '$OUT/mock.log'"
fi
exit $fail
