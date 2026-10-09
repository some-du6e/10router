# Codex account-limit failures

Codex stops immediately when every usable account and fallback model has exhausted
its limits. This is automatic and needs no dashboard toggle or Codex config change.
The router tries account and model fallback before deciding that limits are exhausted.

For confirmed limit exhaustion from Codex, the final response is HTTP 400 with
`x-should-retry: false`. Codex displays the plain-text body:

```text
All your accounts have hit their limits. Next account resets in 2 hours.
```

The countdown uses the earliest actual provider reset across the exhausted accounts
and fallback models. Provider resets are stored separately from router retry cooldowns.
If any reset is unknown, the countdown is omitted. Per-account reasons remain in server logs.
The original final status and retry delay are retained in
`x-10router-upstream-status` and `x-10router-retry-after` headers.

Temporary outages, mixed limit/outage failures, and interrupted streams retain normal
retry behavior. Claude and other clients retain their existing HTTP status and retry
headers. Codex request and stream retry limits are not changed.

Limit classification is stored with each model's cooldown, so an error on another
model cannot change its meaning. Existing cooldowns without this metadata keep
normal retries until the router records a fresh result. Timed-out or empty fusion
panel responses also remain unconfirmed and retryable.

The existing **Wait out rate limits** setting and per-key hold overrides still work.
When the existing hold path waits, this change does not turn that response into a
terminal error. Combo routing retains its existing fallback behavior.

## Verification

With root dependencies installed and `codex` on `PATH`, run:

```bash
node tests/integration/codex-fast-fail.mjs
```

The script starts an isolated Next server, temporary database, mock upstream, and
separate Codex home. It checks immediate limit failures with default Codex retries,
account/model fallback, stream interruption followed by successful client recovery,
and ordinary 503/Claude/generic-client responses. No inference credentials are needed.
Results and server logs stay in the printed temporary directory.
Use `FAST_FAIL_TEST_PORT` to choose another port.
