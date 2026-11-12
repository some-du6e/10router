# Sourced by the early-headers E2E scripts, from a built app checkout. Starts the
# mock upstream, a seeded 10router and a Cloudflare quick tunnel, and sets
# HERE, OUT, E2E_API_KEY and TUNNEL. Extra server env: SERVER_ENV="K=V ...".
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT_DIR:-$PWD/e2e-out}"
mkdir -p "$OUT"
export DATA_DIR="$OUT/data"
mkdir -p "$DATA_DIR"
# Fake, per-run 10router key; the tunnel makes requests non-local. A caller
# that made (and masked) one already passes it in.
export E2E_API_KEY="${E2E_API_KEY:-sk-e2e-$(openssl rand -hex 12)}"

node "$HERE/mock-upstream.mjs" > "$OUT/mock.log" 2>&1 &
node --experimental-loader=./scripts/resolve-src-alias.mjs "$HERE/seed.mjs" 2>&1 | grep -v -i warning

# The upstream's own connect timeout (60s, retried) would end the wait before
# Cloudflare does; raise it so the only clock is Cloudflare's.
# shellcheck disable=SC2086
env ${SERVER_ENV:-} JWT_SECRET="e2e-$(openssl rand -hex 16)" FETCH_CONNECT_TIMEOUT_MS=300000 PORT=20128 HOSTNAME=127.0.0.1 \
  node custom-server.js --port 20128 > "$OUT/server.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:20128/v1/models && break
  sleep 2
done
curl -sf -o /dev/null http://127.0.0.1:20128/v1/models || { echo "server did not start"; tail -50 "$OUT/server.log"; exit 1; }

# Quick tunnels are rate-limited (429) when several jobs ask at once, so a
# cloudflared that exits without a URL is started again, up to 4 times. Its
# errors name api.trycloudflare.com, which is not a tunnel URL.
TUNNEL=""
for attempt in 1 2 3 4; do
  cloudflared tunnel --no-autoupdate --url http://127.0.0.1:20128 > "$OUT/cloudflared.log" 2>&1 &
  tunnel_pid=$!
  for _ in $(seq 1 60); do
    TUNNEL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$OUT/cloudflared.log" | grep -v '^https://api\.' | head -1)"
    [ -n "$TUNNEL" ] && break
    kill -0 "$tunnel_pid" 2>/dev/null || break
    sleep 2
  done
  [ -n "$TUNNEL" ] && break
  kill "$tunnel_pid" 2>/dev/null
  echo "no tunnel URL (attempt $attempt): $(grep -m1 -i 'failed' "$OUT/cloudflared.log")"
  sleep $(( attempt * 20 ))
done
[ -n "$TUNNEL" ] || { echo "no tunnel URL"; cat "$OUT/cloudflared.log"; exit 1; }
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $E2E_API_KEY" "$TUNNEL/v1/models")" = "200" ] && break
  sleep 3
done
echo "tunnel: $TUNNEL"

show() { echo "::group::$1"; cat "$2" 2>/dev/null; echo; echo "::endgroup::"; }
fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }
# wait_for <name>...: until every <name>.meta exists (at most ~8 min).
wait_for() {
  for _ in $(seq 1 100); do
    local done_all=1 f
    for f in "$@"; do [ -s "$OUT/$f.meta" ] || done_all=0; done
    [ "$done_all" = 1 ] && return 0
    sleep 5
  done
}
