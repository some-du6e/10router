# Client configuration

Use the local gateway for clients that accept a custom OpenAI-compatible endpoint:

```text
Endpoint: http://127.0.0.1:20128/v1
API key:  generate one in the dashboard
Model:    <provider-prefix>/<model>
```

The dashboard's CLI Tools pages can generate configuration for supported clients.

## Cursor

```text
OpenAI API Base URL: http://127.0.0.1:20128/v1
OpenAI API Key:      your 10router API key
Model:               cc/claude-opus-4-7
```

## Claude Code

In `~/.claude/config.json`:

```json
{
  "anthropic_api_base": "http://127.0.0.1:20128/v1",
  "anthropic_api_key": "your-10router-api-key"
}
```

## Codex CLI

Use Dashboard → CLI Tools → Codex CLI and leave the endpoint mode set to **Native**.
That configures Codex for the custom Responses backend at:

```text
http://127.0.0.1:20128/backend-api/codex
```

For a manual `~/.codex/config.toml`, the provider needs the native Codex settings:

```toml
[model_providers.10router]
name = "openai"
base_url = "http://127.0.0.1:20128/backend-api/codex"
model_catalog_url = "http://127.0.0.1:20128/backend-api/codex/models"
wire_api = "responses"
requires_openai_auth = true
```

`model_catalog_url` matters when Codex is signed in with an API key (`codex login --with-api-key`).
Without it, Codex never reads 10router's model list, uses generic settings for any model it
doesn't know, and gives that model no `apply_patch` tool, so it edits files through the shell.
Codex has the setting from 0.156; with an API key it reads it by default from 0.161 (0.156 to
0.160 also need `[features] api_key_model_discovery = true`).

With `model_catalog_url` set, Codex uses only that list, whether it's signed in with an API
key or with ChatGPT, and looks up its `model` there by exact name:

- If your API key has a model allowlist with bare names (`gpt-5.5`, `claude-opus-5-5`), leave
  `model_catalog_url` out. The list shows those models under the bare names only, and routing
  a bare name differs from routing the provider id you picked, so Codex wouldn't find the
  model it's set to. Without the line, Codex keeps its own list as before: GPT models get
  Codex's own settings, but other models (Claude, for one) don't get `apply_patch` yet. The
  dashboard's Codex setup leaves it out for such a key.
- A context-window suffix such as `cc/claude-opus-5[1m]` isn't in the list (the router doesn't
  know which models take one), so Codex runs such a model on generic settings with no
  `apply_patch`. Use the id without the suffix.

The regular `/v1` endpoint is a separate OpenAI-compatible mode. It is not the native
Codex backend.

## Other clients

For Cline, Continue, RooCode, OpenClaw, and similar tools, select an OpenAI-compatible
provider and use `http://127.0.0.1:20128/v1` with an API key from the dashboard.
