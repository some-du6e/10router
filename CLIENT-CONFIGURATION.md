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
wire_api = "responses"
requires_openai_auth = true
```

The regular `/v1` endpoint is a separate OpenAI-compatible mode. It is not the native
Codex backend.

## Other clients

For Cline, Continue, RooCode, OpenClaw, and similar tools, select an OpenAI-compatible
provider and use `http://127.0.0.1:20128/v1` with an API key from the dashboard.
