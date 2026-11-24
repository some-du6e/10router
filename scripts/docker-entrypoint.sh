#!/bin/sh
# Container entrypoint (see Dockerfile). Fixes ownership of the mounted data
# dirs, then runs the command as the node user.
#
# GATEWAY_MODE=proxy (or native) runs the command behind the Go gateway
# (docs/GO_GATEWAY.md): the gateway listens on PORT and starts the command on
# the loopback port GATEWAY_APP_PORT. Anything else, unset included, runs the
# command exactly as it ran before the gateway existed.
chown -R node:node /app/data /app/data-home 2>/dev/null
mode=$(printf '%s' "${GATEWAY_MODE:-off}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
case "$mode" in
  proxy|native)
    exec su-exec node /app/gateway/10router-gateway -- "$@"
    ;;
  off|false|0|"")
    ;;
  *)
    echo "[Gateway] GATEWAY_MODE=$GATEWAY_MODE is not off, proxy or native; running the app server alone" >&2
    ;;
esac
exec su-exec node "$@"
