#!/usr/bin/env bash
# Key budgets E2E. Run from a built app checkout with claude and codex on PATH.
# Real Claude Code and Codex CLIs against a real 10router build and a mock
# upstream: budget (402), model allowlist (403), GET /v1/key, the dashboard key
# list, and spend from a stream the client hangs up on. Keys are fake and
# per-run, and are never printed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT_DIR:-$PWD/e2e-out}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
BASE=http://127.0.0.1:20128
MOCK=http://127.0.0.1:9999
CC_MODEL="mc/claude-opus-5-5"      # $4/$20 per 1M: one mock reply = 2000 in + 300 out = $0.014
CC_OTHER="mc/claude-sonnet-5"
CODEX_MODEL="mx/gpt-5.1-codex"     # $1.25/$10 per 1M: one mock reply = 8000 in + 900 out = $0.019
export INITIAL_PASSWORD="e2e-pw-$(openssl rand -hex 8)"

ROWS=()
fail=0
row() { # step result detail
  ROWS+=("$1|$2|$3")
  echo "$2: $1 - $3"
  [ "$2" = PASS ] || fail=1
}
jget() { node -e 'try { const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((v, k) => v?.[k], o); console.log(v === undefined ? "undefined" : typeof v === "object" ? JSON.stringify(v) : String(v)); } catch { console.log("unreadable"); }' "$1" "$2"; }
gt() { node -e 'process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)' "$1" "$2"; }
mock_total() { curl -s "$MOCK/__stats" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).total))'; }
# key_info <keyvar> <outfile>: GET /v1/key as that key.
key_info() { curl -s -H "Authorization: Bearer ${!1}" "$BASE/v1/key" -o "$2"; }
summary() {
  echo
  echo "================ key budgets E2E summary ================"
  printf '%-58s %-5s %s\n' "STEP" "RESULT" "DETAIL"
  for r in "${ROWS[@]}"; do IFS='|' read -r s res d <<< "$r"; printf '%-58s %-5s %s\n' "$s" "$res" "$d"; done
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "| Step | Result | Detail |"; echo "|---|---|---|"
      for r in "${ROWS[@]}"; do IFS='|' read -r s res d <<< "$r"; echo "| $s | $res | $d |"; done; } >> "$GITHUB_STEP_SUMMARY"
  fi
}
trap summary EXIT

# ---- Stack -------------------------------------------------------------------
node "$HERE/mock-upstream.mjs" > "$OUT/mock.log" 2>&1 &
node --experimental-loader=./scripts/resolve-src-alias.mjs "$HERE/seed.mjs" 2>&1 | grep -v -i warning
JWT_SECRET="e2e-$(openssl rand -hex 16)" API_KEY_SECRET="e2e-$(openssl rand -hex 16)" MACHINE_ID_SALT=e2e-salt \
  PORT=20128 HOSTNAME=127.0.0.1 node custom-server.js --port 20128 > "$OUT/server.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE/api/health" && break; sleep 2; done
curl -sf -o /dev/null "$BASE/api/health" || { echo "server did not start"; tail -50 "$OUT/server.log"; row "stack up" FAIL "server did not start"; exit 1; }

# ---- 1. Keys through the dashboard API ---------------------------------------
JAR="$OUT/jar"
login=$(curl -s -c "$JAR" -H 'content-type: application/json' -d "{\"password\":\"$INITIAL_PASSWORD\"}" "$BASE/api/auth/login" -o "$OUT/login.json" -w '%{http_code}')
# make_key <name> <limits json> <var>: create, then set limits; the key goes into $<var>.
make_key() {
  curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"name\":\"$1\"}" "$BASE/api/keys" -o "$OUT/create-$1.json"
  local id key
  id=$(jget "$OUT/create-$1.json" id); key=$(jget "$OUT/create-$1.json" key)
  echo "::add-mask::$key"
  printf -v "$3" '%s' "$key"
  printf -v "$3_ID" '%s' "$id"
  PUT_STATUS=200
  [ "$2" = "{}" ] && return 0
  PUT_STATUS=$(curl -s -b "$JAR" -X PUT -H 'content-type: application/json' -d "$2" "$BASE/api/keys/$id" -o "$OUT/limits-$1.json" -w '%{http_code}')
}
make_key cc-budget "{\"budgetUsd\":0.05,\"allowedModels\":[\"$CC_MODEL\"]}" KEY_A; put_a=$PUT_STATUS
make_key unlimited "{}" KEY_B
make_key codex-budget '{"budgetUsd":0.03}' KEY_C; put_c=$PUT_STATUS
make_key cc-allowlist "{\"budgetUsd\":5,\"allowedModels\":[\"$CC_MODEL\"]}" KEY_D; put_d=$PUT_STATUS
key_info KEY_A "$OUT/keyA-0.json"
if [ "$login" = 200 ] && [ "$put_a" = 200 ] && [ "$put_c" = 200 ] && [ "$put_d" = 200 ] && [ -n "$KEY_B" ] \
   && [ "$(jget "$OUT/keyA-0.json" data.limit)" = 0.05 ] && [ "$(jget "$OUT/keyA-0.json" data.allowed_models)" = "[\"$CC_MODEL\"]" ]; then
  row "1. create keys via dashboard API + limits" PASS "login=$login, A: \$0.05 + allowlist, B unlimited, C \$0.03, D allowlist"
else
  row "1. create keys via dashboard API + limits" FAIL "login=$login put A/C/D=$put_a/$put_c/$put_d limit=$(jget "$OUT/keyA-0.json" data.limit)"
  cat "$OUT/keyA-0.json"; echo
fi

# ---- Claude Code -------------------------------------------------------------
export CLAUDE_CONFIG_DIR="$OUT/claude-config" DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
mkdir -p "$CLAUDE_CONFIG_DIR"
cc() { # name keyvar model -> sets CC_EXIT, output in $OUT/<name>.out
  ANTHROPIC_BASE_URL="$BASE" ANTHROPIC_API_KEY="${!2}" ANTHROPIC_SMALL_FAST_MODEL="$3" ANTHROPIC_DEFAULT_HAIKU_MODEL="$3" \
    CLAUDE_CODE_MAX_RETRIES=0 timeout 180 claude -p "say hi" --model "$3" < /dev/null > "$OUT/$1.out" 2>&1
  CC_EXIT=$?
  sleep 1
}

# ---- 2. Usage rises with each call -------------------------------------------
ok_calls=0; rising=1; prev=0; n=0
while [ "$n" -lt 8 ]; do
  n=$((n + 1))
  key_info KEY_A "$OUT/keyA-pre-$n.json"
  [ "$(jget "$OUT/keyA-pre-$n.json" data.budget_exhausted)" = true ] && break
  cc "cc-$n" KEY_A "$CC_MODEL"
  key_info KEY_A "$OUT/keyA-post-$n.json"
  used=$(jget "$OUT/keyA-post-$n.json" data.usage)
  echo "claude call $n: exit=$CC_EXIT usage=\$$used text=$(head -c 120 "$OUT/cc-$n.out" | tr '\n' ' ')"
  if [ "$CC_EXIT" = 0 ] && grep -qi "hi there" "$OUT/cc-$n.out"; then ok_calls=$((ok_calls + 1)); fi
  gt "$used" "$prev" || rising=0
  prev=$used
done
curl -s -b "$JAR" "$BASE/api/keys" -o "$OUT/keys-list.json"
dash=$(node -e 'const k = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).keys.find((k) => k.id === process.argv[2]); console.log(k ? `${k.spentUsd} ${k.requestCount} ${k.budgetUsd}` : "missing")' "$OUT/keys-list.json" "$KEY_A_ID")
read -r dash_spent dash_reqs dash_budget <<< "$dash"
if [ "$ok_calls" -ge 2 ] && [ "$rising" = 1 ]; then
  row "2a. claude -p succeeds, GET /v1/key usage rises per call" PASS "$ok_calls ok calls, usage \$$prev"
else
  row "2a. claude -p succeeds, GET /v1/key usage rises per call" FAIL "ok=$ok_calls rising=$rising usage=\$$prev"
fi
if gt "$dash_spent" 0 && [ "$dash_spent" = "$prev" ] && [ "$dash_budget" = 0.05 ]; then
  row "2b. dashboard key list shows spend" PASS "spentUsd=\$$dash_spent requests=$dash_reqs budget=\$$dash_budget"
else
  row "2b. dashboard key list shows spend" FAIL "dashboard=$dash v1/key=\$$prev"
fi

# ---- 3. Over budget: 402, nothing upstream -----------------------------------
key_info KEY_A "$OUT/keyA-over.json"
before=$(mock_total)
cc cc-over KEY_A "$CC_MODEL"
after=$(mock_total)
show_over=$(head -c 300 "$OUT/cc-over.out" | tr '\n' ' ')
echo "claude over budget: exit=$CC_EXIT out=$show_over"
code=$(curl -s -o "$OUT/over-curl.json" -w '%{http_code}' -X POST "$BASE/v1/messages" -H "x-api-key: $KEY_A" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$CC_MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
after2=$(mock_total)
if [ "$(jget "$OUT/keyA-over.json" data.budget_exhausted)" = true ] && [ "$CC_EXIT" != 0 ] && grep -qiE "budget|402|billing|credit" "$OUT/cc-over.out" && [ "$before" = "$after" ]; then
  row "3a. claude -p over budget fails with budget msg, no upstream req" PASS "exit=$CC_EXIT, mock requests $before -> $after"
else
  row "3a. claude -p over budget fails with budget msg, no upstream req" FAIL "exhausted=$(jget "$OUT/keyA-over.json" data.budget_exhausted) exit=$CC_EXIT mock $before -> $after"
fi
if [ "$code" = 402 ] && [ "$(jget "$OUT/over-curl.json" error.type)" = billing_error ] && [ "$after" = "$after2" ]; then
  row "3b. /v1/messages over budget = 402 billing_error" PASS "$(jget "$OUT/over-curl.json" error.message | head -c 90)"
else
  row "3b. /v1/messages over budget = 402 billing_error" FAIL "http=$code type=$(jget "$OUT/over-curl.json" error.type) mock $after -> $after2"
fi

# ---- 4. Codex ----------------------------------------------------------------
export CODEX_HOME="$OUT/codex-home"
mkdir -p "$CODEX_HOME" "$OUT/codex-work"
cat > "$CODEX_HOME/config.toml" <<TOML
model = "$CODEX_MODEL"
model_provider = "tenrouter"
model_reasoning_effort = "low"

[model_providers.tenrouter]
name = "10router e2e"
base_url = "$BASE/v1"
env_key = "E2E_CODEX_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
TOML
codex_run() { # name -> CX_EXIT
  ( cd "$OUT/codex-work" && E2E_CODEX_KEY="$KEY_C" timeout 180 codex exec --skip-git-repo-check -s read-only "say hi" < /dev/null > "$OUT/$1.out" 2>&1 )
  CX_EXIT=$?
  sleep 1
}
cx_ok=0; prev=0; rising=1; n=0
while [ "$n" -lt 6 ]; do
  n=$((n + 1))
  key_info KEY_C "$OUT/keyC-pre-$n.json"
  [ "$(jget "$OUT/keyC-pre-$n.json" data.budget_exhausted)" = true ] && break
  codex_run "codex-$n"
  key_info KEY_C "$OUT/keyC-post-$n.json"
  used=$(jget "$OUT/keyC-post-$n.json" data.usage)
  echo "codex call $n: exit=$CX_EXIT usage=\$$used"
  if [ "$CX_EXIT" = 0 ] && grep -qi "hi there" "$OUT/codex-$n.out"; then cx_ok=$((cx_ok + 1)); fi
  gt "$used" "$prev" || rising=0
  prev=$used
done
if [ "$cx_ok" -ge 1 ] && [ "$rising" = 1 ]; then
  row "4a. codex exec succeeds, usage rises" PASS "$cx_ok ok calls, usage \$$prev of \$0.03"
else
  row "4a. codex exec succeeds, usage rises" FAIL "ok=$cx_ok rising=$rising usage=\$$prev"
  tail -c 1500 "$OUT/codex-1.out"
fi
key_info KEY_C "$OUT/keyC-over.json"
before=$(mock_total)
codex_run codex-over
after=$(mock_total)
echo "codex over budget: exit=$CX_EXIT out=$(tail -c 400 "$OUT/codex-over.out" | tr '\n' ' ')"
code=$(curl -s -o "$OUT/codex-curl.json" -w '%{http_code}' -X POST "$BASE/v1/responses" -H "Authorization: Bearer $KEY_C" \
  -H 'content-type: application/json' -d "{\"model\":\"$CODEX_MODEL\",\"input\":\"hi\"}")
after2=$(mock_total)
if [ "$(jget "$OUT/keyC-over.json" data.budget_exhausted)" = true ] && [ "$CX_EXIT" != 0 ] && grep -qiE "budget|402|quota" "$OUT/codex-over.out" && [ "$before" = "$after" ]; then
  row "4b. codex exec over budget fails, no upstream req" PASS "exit=$CX_EXIT, mock requests $before -> $after"
else
  row "4b. codex exec over budget fails, no upstream req" FAIL "exhausted=$(jget "$OUT/keyC-over.json" data.budget_exhausted) exit=$CX_EXIT mock $before -> $after"
fi
if [ "$code" = 402 ] && [ "$(jget "$OUT/codex-curl.json" error.code)" = key_budget_exceeded ] && [ "$after" = "$after2" ]; then
  row "4c. /v1/responses over budget = 402 insufficient_quota" PASS "type=$(jget "$OUT/codex-curl.json" error.type)"
else
  row "4c. /v1/responses over budget = 402 insufficient_quota" FAIL "http=$code code=$(jget "$OUT/codex-curl.json" error.code)"
fi

# ---- 5. Allowlist ------------------------------------------------------------
before=$(mock_total)
cc cc-denied KEY_D "$CC_OTHER"
after=$(mock_total)
echo "claude disallowed model: exit=$CC_EXIT out=$(head -c 300 "$OUT/cc-denied.out" | tr '\n' ' ')"
code=$(curl -s -o "$OUT/denied-curl.json" -w '%{http_code}' -X POST "$BASE/v1/messages" -H "x-api-key: $KEY_D" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$CC_OTHER\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
after2=$(mock_total)
if [ "$CC_EXIT" != 0 ] && grep -qiE "403|not allowed|permission" "$OUT/cc-denied.out" && [ "$before" = "$after" ] \
   && [ "$code" = 403 ] && [ "$(jget "$OUT/denied-curl.json" error.type)" = permission_error ] && [ "$after" = "$after2" ]; then
  row "5a. claude -p disallowed model = 403 permission_error, no upstream" PASS "exit=$CC_EXIT, mock $before -> $after2"
else
  row "5a. claude -p disallowed model = 403 permission_error, no upstream" FAIL "exit=$CC_EXIT http=$code type=$(jget "$OUT/denied-curl.json" error.type) mock $before -> $after -> $after2"
fi
cc cc-allowed KEY_D "$CC_MODEL"
cc_allowed_exit=$CC_EXIT
cc cc-unlimited KEY_B "$CC_OTHER"
if [ "$cc_allowed_exit" = 0 ] && grep -qi "hi there" "$OUT/cc-allowed.out" && [ "$CC_EXIT" = 0 ] && grep -qi "hi there" "$OUT/cc-unlimited.out"; then
  row "5b. allowed model on key D, any model on unlimited key B" PASS "both answered"
else
  row "5b. allowed model on key D, any model on unlimited key B" FAIL "D exit=$cc_allowed_exit B exit=$CC_EXIT"
fi

# ---- 6. Client hangs up mid-stream: charged at least the time floor -----------
# The mock sends message_delta only ~15 s in; the client hangs up ~5 s in (20
# deltas x 250 ms). The drain is off by default, so the charge is input
# (1000 x $4/1M) plus output of at least STREAM_ABORT_FLOOR_TPS (150) tokens per
# second it ran, at $20/1M, and at most the request's max_tokens (8000).
make_key abort-budget '{"budgetUsd":100}' KEY_E
key_info KEY_E "$OUT/keyE-pre-abort.json"
pre=$(jget "$OUT/keyE-pre-abort.json" data.usage)
KEY="$KEY_E" node "$HERE/abort-client.mjs" "$BASE" "$CC_MODEL" 20 > "$OUT/abort.out" 2>&1
post=$pre
for _ in $(seq 1 20); do
  sleep 1
  key_info KEY_E "$OUT/keyE-post-abort.json"
  post=$(jget "$OUT/keyE-post-abort.json" data.usage)
  [ "$post" != "$pre" ] && break
done
# No second charge for the same request (abort plus the stream's own end).
sleep 2
key_info KEY_E "$OUT/keyE-final.json"
final=$(jget "$OUT/keyE-final.json" data.usage)
requests=$(jget "$OUT/keyE-final.json" data.requests)
elapsed=$(jget "$OUT/abort.out" elapsedMs)
delta=$(node -e 'console.log((Number(process.argv[2]) - Number(process.argv[1])).toFixed(6))' "$pre" "$post")
# The client's elapsed time is a lower bound for the server's (the server's
# clock starts when the upstream answered); allow 10% for timer slack.
MIN=$(node -e 'console.log((0.004 + 0.9 * (Number(process.argv[1]) / 1000) * 150 * 20e-6).toFixed(6))' "$elapsed")
MAX=$(node -e 'console.log((0.004 + 8000 * 20e-6).toFixed(6))')
echo "abort client: $(cat "$OUT/abort.out"); spend \$$pre -> \$$post -> \$$final (+\$$delta), requests=$requests, need \$$MIN..\$$MAX"
if [ "$(jget "$OUT/abort.out" status)" = 200 ] && [ "$(jget "$OUT/abort.out" sawMessageDelta)" = false ] \
   && [ "$final" = "$post" ] && [ "$requests" = 1 ] && ! gt "$MIN" "$delta" && ! gt "$delta" "$MAX"; then
  row "6. aborted stream charged at least the time floor, once" PASS "+\$$delta in \$$MIN..\$$MAX after ${elapsed}ms, no second charge"
else
  row "6. aborted stream charged at least the time floor, once" FAIL "+\$$delta (then \$$final, requests=$requests), need \$$MIN..\$$MAX ($(head -c 160 "$OUT/abort.out"))"
fi

echo "::group::mock upstream log"; cat "$OUT/mock.log"; echo "::endgroup::"
echo "::group::server log (errors and key refusals)"; grep -E 'refused by its limits|ERROR|✗' "$OUT/server.log" | head -60; echo "::endgroup::"
exit $fail
