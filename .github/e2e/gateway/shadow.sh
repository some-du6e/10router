#!/usr/bin/env bash
# Shadow compare E2E on the built image (docs/GO_GATEWAY.md, "Phase 2c"):
# GATEWAY_MODE=native with GATEWAY_SHADOW=1. Node serves every request; for
# each /v1/messages the gateway plans the request as its native route would
# and, for every upstream send Node makes, prepares the same attempt and
# compares URL, headers and body bytes. The claudeprep corpus's requests go
# to a node whose models use the Messages API of shadow-upstream.mjs, and to
# combos over it. Passes when Go matched every send of every request it
# would have served, and Node sent for each of them. Run from a checkout with
# root deps installed (for the seed and the corpus) and the image built:
#   IMAGE=10router:e2e shadow.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT_DIR:-$PWD/e2e-out}/shadow"
IMAGE="${IMAGE:-10router:e2e}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
LOCAL=http://127.0.0.1:20128

fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
show() { echo "::group::$1"; cat "$2" 2>/dev/null; echo; echo "::endgroup::"; }
code_of() { curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$@"; }
json() { node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$1"; }
cleanup() {
  docker rm -f gw-shadow > /dev/null 2>&1
  kill $(jobs -p) 2> /dev/null
}
trap cleanup EXIT

node "$HERE/shadow-upstream.mjs" > "$OUT/mock.log" 2>&1 &
node --experimental-loader=./scripts/resolve-src-alias.mjs "$HERE/shadow-seed.mjs" > "$OUT/seed.log" 2>&1 \
  || { echo "seed failed"; cat "$OUT/seed.log"; exit 1; }
grep -v -i warning "$OUT/seed.log"

docker rm -f gw-shadow > /dev/null 2>&1
docker run -d --name gw-shadow --network host \
  -v "$DATA_DIR:/app/data" -e DATA_DIR=/app/data \
  -e JWT_SECRET="e2e-$(openssl rand -hex 16)" -e PORT=20128 -e HOSTNAME=0.0.0.0 \
  -e GATEWAY_MODE=native -e GATEWAY_SHADOW=1 -e MODEL_CATALOG_SYNC=off "$IMAGE" > /dev/null
up=0
for _ in $(seq 1 90); do [ "$(code_of "$LOCAL/v1/models")" = 200 ] && { up=1; break; }; sleep 2; done
if [ "$up" != 1 ]; then
  echo "the container did not answer"; docker logs gw-shadow 2>&1 | tail -80; exit 1
fi
# The native route needs the database open and its snapshot loaded.
for _ in $(seq 1 30); do curl -s "$LOCAL/_gateway/health" | grep -q '"native":"ready"' && break; sleep 1; done
curl -s "$LOCAL/_gateway/health" > "$OUT/health-before.json"
show "health before" "$OUT/health-before.json"
check "the native route is ready" "[ \"\$(json native < '$OUT/health-before.json')\" = ready ]"

node "$HERE/shadow-drive.mjs" "$LOCAL" > "$OUT/drive.json"
show "requests" "$OUT/drive.json"
# Node's last reports, then the gateway's 2 s grace before it scores a request.
sleep 5
curl -s "$LOCAL/_gateway/health" > "$OUT/health.json"
docker logs gw-shadow > "$OUT/container.log" 2>&1
node -e 'const h=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(h.shadow,null,1))' < "$OUT/health.json" > "$OUT/shadow.json"
show "shadow compare" "$OUT/shadow.json"
show "shadow log lines" <(grep -F '[Gateway] shadow' "$OUT/container.log" | head -80)

s() { json "$1" < "$OUT/shadow.json"; }
# The corpus's only declines: a body that doesn't stream, and one that may
# need a model capability. Any other reason is a request Node serves and the
# native route has stopped planning.
node -e '
  const reasons = JSON.parse(require("fs").readFileSync(0, "utf8")).reasons || {};
  const allowed = [/^route: proxy to Node: not stream: true$/, /^combo: proxy to Node: a request that may need a model capability/];
  const other = Object.keys(reasons).filter((r) => !allowed.some((a) => a.test(r)));
  console.log(other.join("\n"));
' < "$OUT/shadow.json" > "$OUT/other-reasons.txt"
check "every request reached Node and was served ($(json statuses < "$OUT/drive.json"))" \
  "[ \"\$(json failures < '$OUT/drive.json')\" = '[]' ]"
check "the gateway saw every request ($(s requests) of $(json sent < "$OUT/drive.json"))" \
  "[ \"\$(s requests)\" = \"\$(json sent < '$OUT/drive.json')\" ]"
check "it declined only bodies that don't stream or may need a capability ($(s declined) declined)" "[ ! -s '$OUT/other-reasons.txt' ] || { cat '$OUT/other-reasons.txt'; false; }"
check "it planned the rest ($(s planned) planned)" "[ \"\$(s planned)\" -ge 180 ]"
check "every send of a planned request matched byte for byte ($(s matched) matched, $(s differed) differed)" \
  "[ \"\$(s differed)\" = 0 ] && [ \"\$(s matched)\" -ge \"\$(s planned)\" ]"
check "each request's first send was for the plan's first leaf ($(s reordered) not)" "[ \"\$(s reordered)\" = 0 ]"
check "Node sent for every request Go would have sent for ($(s noSend) without a send)" "[ \"\$(s noSend)\" = 0 ]"
check "no report was unknown or failed ($(s unknown) unknown, $(s errors) errors)" "[ \"\$(s unknown)\" = 0 ] && [ \"\$(s errors)\" = 0 ]"
check "every send was reported once ($(s sends) reports, $(grep -c '"method":"POST"' "$OUT/mock.log") upstream requests)" \
  "[ \"\$(s sends)\" = \"\$(grep -c '\"method\":\"POST\"' '$OUT/mock.log')\" ]"
# The catalog's maxOutput is in effect (Node clamped max_tokens to it), so its
# match above shows Go read the same catalog.
check "the seeded catalog's maxOutput reached the upstream" \
  "grep '\"model\":\"zz-catalog-probe-1\"' '$OUT/mock.log' | grep -q '\"max_tokens\":3000'"
show "mock upstream log (first 40)" <(head -40 "$OUT/mock.log")
exit "$fail"
