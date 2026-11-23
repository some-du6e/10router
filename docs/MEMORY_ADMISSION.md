# Memory admission

A chat request in flight holds its prompt several times over until its reply
starts streaming, or until a non-streamed reply ends: the parsed body, the
translated body, and the string sent upstream. A streamed reply lets go of
them once it is under way (with "Show full request details" on it keeps the
parsed and translated bodies for its request detail); the gate still counts
the request until its reply ends.
Coding agents send prompts of several MB, and after a restart they all retry at
once. Enough of them together take the process past its memory limit; it is
killed and every request in flight fails with it.

`src/sse/services/memoryAdmission.js` sits in front of every chat route
(`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/responses/compact`,
the Codex ingress, and the other `handleChat` callers). It runs before the body
is read.

## Rules

- Each admitted request counts as `Content-Length × 3` bytes (or the body's
  length once read, if that is larger) until its reply body ends, fails, or is
  cancelled, or the client hangs up.
- A new request is admitted when its bytes fit the budget
  (`INFLIGHT_BODY_BUDGET_MB`) and the process's resident memory is under the
  high-water mark (`MEMORY_HIGH_WATER_MB`).
- Otherwise it waits in a first-come, first-served queue for up to
  `INFLIGHT_QUEUE_WAIT_MS`. A client that hangs up while waiting leaves the
  queue (499).
- A request still waiting after that gets **503** with `Retry-After:
  INFLIGHT_RETRY_AFTER_S`, in the client's error format:
  - Claude (`/v1/messages`): `{"type":"error","error":{"type":"overloaded_error","message":…}}`
  - OpenAI and Responses: `{"error":{"type":"server_error","code":"service_unavailable","message":…}}`

  The Anthropic and OpenAI SDKs (so Claude Code) and Codex retry a 503.
- With nothing in flight a request is always admitted, however big, so one huge
  prompt is never starved and a resident size that hasn't come down yet can't
  block the gate.

The server logs one line when it starts refusing and one when it admits again.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `INFLIGHT_BODY_BUDGET_MB` | `900` | Budget for the body copies of admitted requests. `0` turns it off. |
| `INFLIGHT_QUEUE_WAIT_MS` | `15000` | Longest a request waits for room. `0` refuses at once. |
| `INFLIGHT_RETRY_AFTER_S` | `10` | `Retry-After` on a refusal. |
| `MEMORY_HIGH_WATER_MB` | 80% of the cgroup limit | Resident memory above which new requests wait. Read from `/sys/fs/cgroup/memory.max` (v2) or `memory.limit_in_bytes` (v1); off when there is no limit. `0` turns it off. |

With both `INFLIGHT_BODY_BUDGET_MB=0` and `MEMORY_HIGH_WATER_MB=0` the gate is
off and requests pass straight through.

## Sizing

Leave room for everything else the process holds: the runtime and caches
(a few hundred MB), and bodies the HTTP layer has buffered for requests still
waiting in the queue (one copy each). With a 2 GiB container, the defaults
(900 MB budget, 1.6 GiB high water) leave that room.
