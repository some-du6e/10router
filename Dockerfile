# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
ARG GO_IMAGE=golang:1.24-alpine

# The Go gateway (gateway/, docs/GO_GATEWAY.md). A static binary: the runner is
# Alpine with no cgo. It only runs when GATEWAY_MODE=proxy or native. Built on
# the build machine's platform and cross-compiled, so a multi-arch build
# doesn't run the Go compiler under emulation.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS gateway
WORKDIR /src
COPY gateway/ ./
ARG SOURCE_COMMIT
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
  CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
  go build -trimpath -ldflags "-s -w -X main.version=${SOURCE_COMMIT:-dev}" \
  -o /out/10router-gateway ./cmd/10router-gateway

FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

# Git commit, as the `SOURCE_COMMIT` build arg: .github/workflows/deploy-image.yml
# passes it, and so does Coolify when it builds this file with
# `include_source_commit_in_build` on. `.git` is stripped from the build
# context by `.dockerignore`, so `git rev-parse` in next.config.mjs falls back
# to this. Declared here (before `RUN npm run build`) so Docker surfaces it to
# the build step as an env var.
ARG SOURCE_COMMIT

# Optional Google Analytics 4 measurement ID. Next inlines NEXT_PUBLIC_* at build
# time, so pass it with `--build-arg NEXT_PUBLIC_GA_ID=G-...`; unset leaves GA off.
ARG NEXT_PUBLIC_GA_ID
ENV NEXT_PUBLIC_GA_ID=$NEXT_PUBLIC_GA_ID

# The dashboard reads NEXT_PUBLIC_CLOUD_URL in the browser, so it is inlined at
# build time too: pass it with `--build-arg`. `.env*` files never reach the
# build context (`.dockerignore`). A bare ARG is visible to `npm run build` only
# when passed, so an unset value stays unset instead of being baked in as "".
ARG NEXT_PUBLIC_CLOUD_URL

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="10router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/server-drain.js ./server-drain.js
COPY --from=builder /app/open-sse ./open-sse
COPY --from=builder /app/THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY --from=builder /app/src/lib/upgrades/retireIdeProxy.cjs ./src/lib/upgrades/retireIdeProxy.cjs
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id

# The on-disk data dir stays ".9router" (not ".10router") for compatibility with existing installs.
RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Copied after the chown above, so the binary itself stays root-owned.
COPY --from=gateway /out/10router-gateway /app/gateway/10router-gateway

# Fix permissions at runtime (handles mounted volumes), then run the command as
# node: alone (GATEWAY_MODE unset or off, the default) or behind the gateway.
RUN apk --no-cache upgrade && apk --no-cache add su-exec
COPY --chmod=755 scripts/docker-entrypoint.sh /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
