# Docker

Run 10router in a container. Published image: [`some-du6e/10router`](https://hub.docker.com/r/some-du6e/10router) — multi-platform `linux/amd64` + `linux/arm64`.

> Note: the on-disk data directory is still named `.9router` everywhere below. That name is
> retained deliberately for compatibility with existing installs — renaming it would orphan
> the data of anyone upgrading from an earlier release.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 10router \
  some-du6e/10router:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f 10router        # view logs
docker stop 10router           # stop
docker start 10router          # start again
docker rm -f 10router          # remove
```

## Data persistence

```bash
# Host path keeps the ".9router" name for compatibility with existing installs.
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows) — these paths are unchanged by the rebrand. In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 10router \
  some-du6e/10router:latest
```

## Update to latest

```bash
docker pull some-du6e/10router:latest
docker rm -f 10router
# re-run the quick start command
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
cd app && docker build -t 10router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  10router
```

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and pushes to:
- `ghcr.io/some-du6e/10router:v{version}` + `:latest`
- `some-du6e/10router:v{version}` + `:latest`

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.4.x && git push origin v0.4.x
```

Workflow: `app/.github/workflows/docker-publish.yml`
