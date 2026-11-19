#!/usr/bin/env bash
# Management keys, end to end with the real Claude Code and Codex CLIs. Run from
# a built app checkout with claude and codex on PATH. The dashboard makes a
# management key; only that key makes the client key the CLIs then use, against
# a real 10router build and the key-budgets mock upstream. Every key is fake,
# made per run, masked, and never printed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT_DIR:-$PWD/e2e-out}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
BASE=http://127.0.0.1:20128
MODEL="mc/claude-opus-5-5"
OTHER="mc/claude-sonnet-5"
export INITIAL_PASSWORD="e2e-pw-$(openssl rand -hex 8)"
echo "::add-mask::$INITIAL_PASSWORD"

ROWS=()
fail=0
row() { # step result detail
  ROWS+=("$1|$2|$3")
  echo "$2: $1 - $3"
  [ "$2" = PASS ] || fail=1
}
jget() { node -e 'try { const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = process.argv[2].split(".").reduce((v, k) => v?.[k], o); console.log(v === undefined ? "undefined" : typeof v === "object" ? JSON.stringify(v) : String(v)); } catch { console.log("unreadable"); }' "$1" "$2"; }
gt() { node -e 'process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)' "$1" "$2"; }
summary() {
  echo
  echo "================ management keys CLI E2E summary ================"
  printf '%-64s %-5s %s\n' "STEP" "RESULT" "DETAIL"
  for r in "${ROWS[@]}"; do IFS='|' read -r s res d <<< "$r"; printf '%-64s %-5s %s\n' "$s" "$res" "$d"; done
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "| Step | Result | Detail |"; echo "|---|---|---|"
      for r in "${ROWS[@]}"; do IFS='|' read -r s res d <<< "$r"; echo "| $s | $res | $d |"; done; } >> "$GITHUB_STEP_SUMMARY"
  fi
}
trap summary EXIT

# ---- Stack -------------------------------------------------------------------
# Small mock usage: one reply is 200 in + 30 out on opus ($4/$20 per 1M) = $0.0014.
MOCK_INPUT_TOKENS=200 MOCK_OUTPUT_TOKENS=30 node "$HERE/../key-budgets/mock-upstream.mjs" > "$OUT/mock.log" 2>&1 &
node --experimental-loader=./scripts/resolve-src-alias.mjs "$HERE/seed.mjs" 2>&1 | grep -v -i warning
JWT_SECRET="e2e-$(openssl rand -hex 16)" API_KEY_SECRET="e2e-$(openssl rand -hex 16)" MACHINE_ID_SALT=e2e-salt \
  PORT=20128 HOSTNAME=127.0.0.1 node custom-server.js --port 20128 > "$OUT/server.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf -o /dev/null "$BASE/api/health" && break; sleep 2; done
curl -sf -o /dev/null "$BASE/api/health" || { tail -50 "$OUT/server.log"; row "stack up" FAIL "server did not start"; exit 1; }

JAR="$OUT/jar"
login=$(curl -s -c "$JAR" -H 'content-type: application/json' -d "{\"password\":\"$INITIAL_PASSWORD\"}" "$BASE/api/auth/login" -o "$OUT/login.json" -w '%{http_code}')
# mgmt <method> <path> <outfile> [json body]: the management API with only the management key.
mgmt() {
  curl -s -X "$1" -H "Authorization: Bearer $MGMT" -H 'content-type: application/json' ${4:+-d "$4"} "$BASE$2" -o "$3" -w '%{http_code}'
}

# ---- 1. Dashboard makes the management key -----------------------------------
code=$(curl -s -b "$JAR" -H 'content-type: application/json' \
  -d "{\"name\":\"e2e cli\",\"scopes\":{\"clientKeys\":{\"enabled\":true,\"models\":[\"$MODEL\"],\"maxBudgetUsd\":1}}}" \
  "$BASE/api/management-keys" -o "$OUT/mgmt-create.json" -w '%{http_code}')
MGMT=$(jget "$OUT/mgmt-create.json" secret)
echo "::add-mask::$MGMT"
MGMT_ID=$(jget "$OUT/mgmt-create.json" managementKey.id)
me=$(mgmt GET /api/management/v1/me "$OUT/me.json")
if [ "$login" = 200 ] && [ "$code" = 201 ] && [[ "$MGMT" == 10r-mgmt-* ]] && [ "$me" = 200 ] \
   && [ "$(jget "$OUT/me.json" managementKey.scopes.clientKeys.models)" = "[\"$MODEL\"]" ] \
   && [ "$(jget "$OUT/me.json" managementKey.scopes.clientKeys.maxBudgetUsd)" = 1 ]; then
  row "1. dashboard creates a clientKeys management key (1 model, \$1 cap)" PASS "login=$login create=$code me=$me"
else
  row "1. dashboard creates a clientKeys management key (1 model, \$1 cap)" FAIL "login=$login create=$code me=$me scopes=$(jget "$OUT/me.json" managementKey.scopes)"
fi

# ---- 2. Only the management key makes the client key -------------------------
c=$(mgmt POST /api/management/v1/client-keys "$OUT/ck-create.json" "{\"name\":\"e2e cli client\",\"budgetUsd\":0.05,\"allowedModels\":[\"$MODEL\"]}")
KEY=$(jget "$OUT/ck-create.json" key)
echo "::add-mask::$KEY"
KEY_ID=$(jget "$OUT/ck-create.json" clientKey.id)
oos=$(mgmt POST /api/management/v1/client-keys "$OUT/ck-oos.json" "{\"name\":\"x\",\"budgetUsd\":0.05,\"allowedModels\":[\"$OTHER\"]}")
cap=$(mgmt POST /api/management/v1/client-keys "$OUT/ck-cap.json" "{\"name\":\"x\",\"budgetUsd\":2,\"allowedModels\":[\"$MODEL\"]}")
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/key" -o "$OUT/key-0.json"
if [ "$c" = 201 ] && [[ "$KEY" == sk-* ]] && [ "$oos" = 403 ] && [ "$cap" = 403 ] \
   && [ "$(jget "$OUT/key-0.json" data.limit)" = 0.05 ] && [ "$(jget "$OUT/key-0.json" data.allowed_models)" = "[\"$MODEL\"]" ]; then
  row "2. mgmt key creates client key; out-of-scope model and over-cap refused" PASS "create=$c out-of-scope=$oos over-cap=$cap"
else
  row "2. mgmt key creates client key; out-of-scope model and over-cap refused" FAIL "create=$c out-of-scope=$oos over-cap=$cap limit=$(jget "$OUT/key-0.json" data.limit)"
fi

# ---- 3. Claude Code ----------------------------------------------------------
export CLAUDE_CONFIG_DIR="$OUT/claude-config" DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
mkdir -p "$CLAUDE_CONFIG_DIR"
cc() { # name -> CC_EXIT, output in $OUT/<name>.out
  ANTHROPIC_BASE_URL="$BASE" ANTHROPIC_API_KEY="$KEY" ANTHROPIC_SMALL_FAST_MODEL="$MODEL" ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL" \
    CLAUDE_CODE_MAX_RETRIES=0 timeout 180 claude -p "say hi" --model "$MODEL" < /dev/null > "$OUT/$1.out" 2>&1
  CC_EXIT=$?
  sleep 1
}
# usage_after <prev> <outfile>: GET /v1/key until usage moves past prev (spend is recorded after the stream ends).
usage_after() {
  local u=$1
  for _ in $(seq 1 10); do
    curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/key" -o "$2"
    u=$(jget "$2" data.usage)
    gt "$u" "$1" && break
    sleep 1
  done
  echo "$u"
}
u0=$(jget "$OUT/key-0.json" data.usage)
cc cc-1
u1=$(usage_after "$u0" "$OUT/key-1.json")
echo "claude: exit=$CC_EXIT text=$(head -c 160 "$OUT/cc-1.out" | tr '\n' ' ')"
if [ "$CC_EXIT" = 0 ] && grep -qi "hi there" "$OUT/cc-1.out" && gt "$u1" "$u0"; then
  row "3. claude -p with the client key succeeds, spend rises" PASS "exit=0, usage \$$u0 -> \$$u1"
else
  row "3. claude -p with the client key succeeds, spend rises" FAIL "exit=$CC_EXIT usage \$$u0 -> \$$u1"
fi

# ---- 4. Codex ----------------------------------------------------------------
export CODEX_HOME="$OUT/codex-home"
mkdir -p "$CODEX_HOME" "$OUT/codex-work"
cat > "$CODEX_HOME/config.toml" <<TOML
model = "$MODEL"
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
( cd "$OUT/codex-work" && E2E_CODEX_KEY="$KEY" timeout 180 codex exec --skip-git-repo-check -s read-only "say hi" < /dev/null > "$OUT/codex-1.out" 2>&1 )
CX_EXIT=$?
u2=$(usage_after "$u1" "$OUT/key-2.json")
if [ "$CX_EXIT" = 0 ] && grep -qi "hi there" "$OUT/codex-1.out"; then
  row "4. codex exec with the client key succeeds" PASS "exit=0, usage \$$u1 -> \$$u2"
else
  row "4. codex exec with the client key succeeds" FAIL "exit=$CX_EXIT usage \$$u1 -> \$$u2"
  tail -c 1500 "$OUT/codex-1.out"
fi

# ---- 5. GET /v1/models lists only the allowed model --------------------------
m=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models" -o "$OUT/models.json" -w '%{http_code}')
ids=$(node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).data || []; console.log(JSON.stringify(d.map((m) => m.id)))' "$OUT/models.json" 2>/dev/null)
if [ "$m" = 200 ] && [ "$ids" = "[\"$MODEL\"]" ]; then
  row "5. GET /v1/models with the client key lists only the allowed model" PASS "$ids"
else
  row "5. GET /v1/models with the client key lists only the allowed model" FAIL "http=$m ids=$(echo "$ids" | head -c 200)"
fi

# ---- 6. The management key is no inference key -------------------------------
v1=$(curl -s -X POST -H "Authorization: Bearer $MGMT" -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" "$BASE/v1/chat/completions" -o "$OUT/mgmt-v1.json" -w '%{http_code}')
cx=$(curl -s -X POST -H "Authorization: Bearer $MGMT" -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":\"hi\"}" "$BASE/backend-api/codex/responses" -o "$OUT/mgmt-codex.json" -w '%{http_code}')
if [ "$v1" = 401 ] && [ "$cx" = 401 ] && grep -q "management key can't be used for inference" "$OUT/mgmt-v1.json" \
   && grep -q "management key can't be used for inference" "$OUT/mgmt-codex.json"; then
  row "6. mgmt key refused on /v1/chat/completions and /backend-api/codex" PASS "401 / 401"
else
  row "6. mgmt key refused on /v1/chat/completions and /backend-api/codex" FAIL "v1=$v1 codex=$cx"
fi

# ---- 7. Deleting the client key cuts Claude Code off -------------------------
d=$(mgmt DELETE "/api/management/v1/client-keys/$KEY_ID" "$OUT/ck-delete.json")
cc cc-deleted
direct=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/messages" -H "x-api-key: $KEY" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
echo "claude after delete: exit=$CC_EXIT out=$(head -c 300 "$OUT/cc-deleted.out" | tr '\n' ' ')"
if [ "$d" = 200 ] && [ "$CC_EXIT" != 0 ] && grep -qiE "401|invalid api key|authentication" "$OUT/cc-deleted.out" && [ "$direct" = 401 ]; then
  row "7. mgmt API deletes the client key; next claude -p fails with 401" PASS "delete=$d, claude exit=$CC_EXIT, /v1/messages=$direct"
else
  row "7. mgmt API deletes the client key; next claude -p fails with 401" FAIL "delete=$d claude exit=$CC_EXIT /v1/messages=$direct"
fi

# ---- 8. Revoking the management key from the dashboard -----------------------
r=$(curl -s -b "$JAR" -X DELETE "$BASE/api/management-keys/$MGMT_ID" -o "$OUT/mgmt-revoke.json" -w '%{http_code}')
me2=$(mgmt GET /api/management/v1/me "$OUT/me-revoked.json")
list2=$(mgmt GET /api/management/v1/client-keys "$OUT/list-revoked.json")
if [ "$r" = 200 ] && [ "$me2" = 401 ] && [ "$list2" = 401 ]; then
  row "8. dashboard revokes the mgmt key; management API returns 401" PASS "revoke=$r me=$me2 client-keys=$list2"
else
  row "8. dashboard revokes the mgmt key; management API returns 401" FAIL "revoke=$r me=$me2 client-keys=$list2"
fi

# No key in any saved response body except the one create response that hands it out.
leak=$(grep -l -F -e "$MGMT" -e "$KEY" "$OUT"/*.json "$OUT"/*.out 2>/dev/null | grep -v -e mgmt-create.json -e ck-create.json || true)
[ -z "$leak" ] && row "no response leaked a key" PASS "" || row "no response leaked a key" FAIL "$leak"

echo "::group::mock upstream log"; cat "$OUT/mock.log"; echo "::endgroup::"
echo "::group::server log (errors and refusals)"; grep -E 'refused|ERROR|✗|AUTH' "$OUT/server.log" | head -60; echo "::endgroup::"
exit $fail
