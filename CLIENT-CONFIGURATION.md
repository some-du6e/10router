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
# Needs Codex 0.166 or newer; remove for older Codex.
model_catalog_url = "http://127.0.0.1:20128/backend-api/codex/models"
wire_api = "responses"
requires_openai_auth = true
```

`model_catalog_url` matters when Codex is signed in with an API key (`codex login --with-api-key`).
Without it, Codex never reads 10router's model list, uses generic settings for any model it
doesn't know, and gives that model no `apply_patch` tool, so it edits files through the shell.
What the line does depends on the Codex version:

- **0.166 and newer:** Codex uses only 10router's list, signed in with an API key or with
  ChatGPT, and looks up its `model` there by exact name. This is the version the line is for.
- **0.160 to 0.165:** the same exact-name mode, but Codex refuses a list over 1 MiB, which
  10router's usually is (each model carries Codex's prompt), and then has no models at all.
  It also needs `[features] api_key_model_discovery = true` before 0.161. Leave the line out.
- **0.156 to 0.159:** Codex merges the list into its own, but also refuses one over 1 MiB, and
  needs `api_key_model_discovery`. Leave the line out.
- **Before 0.156:** there's no such setting.

The dashboard's Codex setup writes the line only when the installed Codex is 0.166 or newer and
the key you apply with lists your models under the ids being written. In the manual config
above, the comment on the line says the same; delete the line for an older Codex.

- If your API key has a model allowlist that names a model by its bare id (`gpt-5.5` rather
  than `cx/gpt-5.5`), leave `model_catalog_url` out. The list shows that model under the bare
  id only, and routing a bare id differs from routing the provider id you picked, so Codex
  wouldn't find the model it's set to. Without the line, Codex keeps its own list as before:
  GPT models get Codex's own settings, but other models (Claude, for one) don't get
  `apply_patch` yet. The dashboard leaves the line out for such a key.
- After changing an allowlist, apply the Codex settings again on the CLI Tools page, or delete
  the line yourself: a line written for the old allowlist stays in `config.toml`, and with a
  model the key now sees under another name, Codex runs it on generic settings.
- A context-window suffix such as `cc/claude-opus-5[1m]` isn't in the list (the router doesn't
  know which models take one), so Codex runs such a model on generic settings with no
  `apply_patch`. Use the id without the suffix.

The regular `/v1` endpoint is a separate OpenAI-compatible mode. It is not the native
Codex backend.

## Other clients

For Cline, Continue, RooCode, OpenClaw, and similar tools, select an OpenAI-compatible
provider and use `http://127.0.0.1:20128/v1` with an API key from the dashboard.
