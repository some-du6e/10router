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
headers, unless the stream's headers already went out (below). Codex request and
stream retry limits are not changed.

Limit classification is stored with each model's cooldown, so an error on another
model cannot change its meaning. Existing cooldowns without this metadata keep
normal retries until the router records a fresh result. Timed-out or empty fusion
panel responses also remain unconfirmed and retryable.

The existing **Wait out rate limits** setting and per-key hold overrides still work.
When the existing hold path waits, this change does not turn that response into a
terminal error. Combo routing retains its existing fallback behavior.

## After early stream headers

A streaming request with no upstream answer after `STREAM_EARLY_HEADERS_MS` (30s)
already has its 200 and SSE headers, so the final failure can't be an HTTP 400.
For a Responses stream it is a `response.failed` event whose error has code
`invalid_prompt` and the same text as the body above:

```text
event: response.failed
data: {"type":"response.failed","response":{"id":"resp_…","status":"failed","error":{"type":"stream_error","code":"invalid_prompt","message":"All your accounts have hit their limits. Next account resets in 2 hours."}}}
```

Codex treats `invalid_prompt` as final and shows its message as is, so it stops and
keeps the countdown. `insufficient_quota` would also stop Codex, but Codex replaces
it with its own "Quota exceeded. Check your plan and billing details." and the
countdown is lost (codex-rs `codex-api/src/sse/responses_error.rs`
`parse_failed_response`; `protocol/src/error.rs`). Other failures after early
headers get their code from the status:

- 408, 409, 429 and 5xx: `rate_limit_exceeded` (429) or `server_error`. Codex
  always retries both, with backoff when no delay is given. The Anthropic and
  OpenAI SDKs and Claude Code retry this same set of HTTP statuses.
- Anything else, such as 400, 401, 403 or 404, and any failure marked
  `x-should-retry: false` (the limit exhaustion above): `invalid_prompt`, final.

Over HTTP, Codex treats these statuses a little differently (codex-rs
`codex-api/src/api_bridge.rs`, `protocol/src/error.rs` `retry_delay`). A 400 is
final there too, and a 408, 409 or 5xx is retried. A 429 becomes `RetryLimit`,
which is retried only when the response carried `Retry-After`. Any other status
(401, 403, 404, …) becomes `UnexpectedStatus` and is retried. So in-band, a 429
without `Retry-After` is retried where over HTTP it would stop, and 401/403/404
stop where over HTTP they would be retried.

A limit exhaustion reached within the first 30s still gets the HTTP 400 above.

Codex counts only SSE events, not `: keepalive` comments, against its stream idle
timeout (`stream_idle_timeout_ms` in the model provider config, default 300s;
codex-rs `codex-api/src/sse/responses.rs`). So a routing pass still busy about
5 minutes after the early headers ends in Codex with "idle timeout waiting for
SSE", and Codex sends the turn again (up to `stream_max_retries`, default 5),
each time from the first model and account. If fallback can take that long,
raise `stream_idle_timeout_ms` on the client. Claude Code has a similar limit
(`CLAUDE_STREAM_IDLE_TIMEOUT_MS`, default 300s).

Claude Code (2.1.318) retries an in-band `overloaded_error` on the stream only
twice. At the third, or the first for a background query such as title
generation, it logs "Error streaming, falling back to non-streaming mode" and
sends the turn again with `stream: false`. That request gets no early headers,
so behind Cloudflare a routing pass that is still that slow gets a 524 again,
and after its HTTP retries Claude Code shows `API Error: 524`. Set
`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` on the client to keep it retrying
on the stream.

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
