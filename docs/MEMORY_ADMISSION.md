# Memory admission

A chat request in flight holds its prompt several times over until its reply
starts streaming, or until a non-streamed reply ends: the parsed body, the
translated body, and the string sent upstream. A streamed reply lets go of
them once it is under way (with "Show full request details" on it keeps the
parsed and translated bodies for its request detail); the gate still counts
the request until its reply ends. A request waiting for a warm prompt-cache
key keeps only the parsed body until its next attempt.
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
  cancelled, or the client hangs up. A request without `Content-Length` counts
  as `INFLIGHT_UNKNOWN_BODY_MB × 3` until its body is read, then as its real
  length × 3.
- Until its reply starts (a non-streamed one: until it ends), a request is
  also *not yet replying*: it is still reading, parsing, translating and
  serializing its body (again on each 429 fallback), so neither the heap nor
  resident memory shows all of it yet. A reply that went out early (early
  headers) doesn't end that: the request stays not yet replying until its
  routing settles. While it sleeps (a warm-key wait, a JSON client's limit
  hold) it doesn't count, since it builds nothing then, and the gate can let
  others into the room. When it wakes it waits for room to count again,
  ahead of new requests and behind earlier wakers. It isn't turned away (it
  was admitted): it goes on at the latest once nothing else is about to
  allocate, so requests waking together go one at a time. New requests
  don't pass it: one whose wait runs out while a waker waits is refused,
  so the requests already building drain toward it. Its next attempt
  counts. A
  streamed limit hold's reply has started, so it isn't counted at all: its
  re-attempts, when the limit clears, are the one thing the gate doesn't see.
- A new request is admitted when, with it counted too:
  - its `× 3` bytes fit the budget (`INFLIGHT_BODY_BUDGET_MB`);
  - resident memory plus 2 × the bodies not yet replying (their bytes and
    the bytes sent upstream, outside the heap) stays under the high-water
    mark (`MEMORY_HIGH_WATER_MB`);
  - the V8 heap in use plus 3 × the bodies not yet replying stays under
    `MEMORY_HEAP_HIGH_WATER_PCT` of the heap limit (`heap_size_limit`).

  V8 aborts the process ("JavaScript heap out of memory") when its heap fills,
  which can happen with resident memory well under the container's limit; the
  kernel kills it when resident memory reaches the container's limit, which
  can happen with the heap under its own.
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

The server logs one line when it starts refusing, with the reason (`budget`,
`memory` or `heap`), and one when it admits again.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `INFLIGHT_BODY_BUDGET_MB` | `900` | Budget for the body copies of admitted requests. `0` turns it off. |
| `INFLIGHT_QUEUE_WAIT_MS` | `15000` | Longest a new request waits for room. `0` refuses at once. A request waking from a sleep has no deadline (see above). |
| `INFLIGHT_RETRY_AFTER_S` | `10` | `Retry-After` on a refusal. |
| `MEMORY_HIGH_WATER_MB` | 80% of the cgroup limit | Resident memory above which new requests wait. Read from `/sys/fs/cgroup/memory.max` (v2) or `memory.limit_in_bytes` (v1); off when there is no limit. `0` turns it off. |
| `MEMORY_HEAP_HIGH_WATER_PCT` | `85` | Percent of the V8 heap limit that the heap in use plus 3 × the bodies not yet replying (the new request's too) may reach. `0` turns it off. |
| `INFLIGHT_UNKNOWN_BODY_MB` | `4` | What a body without `Content-Length` counts as until it is read. |

With `INFLIGHT_BODY_BUDGET_MB=0`, `MEMORY_HIGH_WATER_MB=0` and
`MEMORY_HEAP_HIGH_WATER_PCT=0` the gate is off and requests pass straight
through.

## Sizing

Leave room for everything else the process holds: the runtime and caches
(a few hundred MB), and bodies the HTTP layer has buffered for requests still
waiting in the queue (one copy each). With a 2 GiB container, the defaults
(900 MB budget, 1.6 GiB high water) leave that room.

**Leave `--max-old-space-size` unset, or keep it at most 60% of the
container's memory.** V8 keeps the pages it has collected until a
memory-reducing collection, so resident memory follows the heap's peak, plus
Buffers, code and the runtime outside it. Node 22 picks about 1 GB by itself
in a 2 GiB container. With 1400 MB in a 2 GiB container, resident memory
reached the container's limit and the kernel killed the process, while the
gate was already refusing; garbage from requests already admitted kept
growing. The server logs a warning when the first chat request arrives if
the heap limit is over 60% of the container.

The heap check follows whatever heap limit the process has. The heap in use
includes garbage not yet collected, so near the mark new requests can wait
for the next collection (the queue rechecks every 250 ms). The weights for
bodies not yet replying come from
`tests/bench/admission-herd-benchmark.test.js` (Node 22, Claude Code bodies
with non-Latin-1 text, through the real route): a request in flight takes
about 1.8-1.9× its body of live heap and 3.5-5.4× of resident memory over a
fresh process. The heap's part is the heap check's; outside the heap are the
body's bytes and the bytes sent upstream, and once a process has peaked V8
keeps its heap pages resident, so new heap allocations mostly reuse them. A parsed
1,000-message body takes 1.1-1.2× its JSON length on the heap, and its text
and the string sent upstream take 1× each (2× each when the body has any
character outside Latin-1, as most do). They are counted on top of whatever
of them the heap and resident memory already show, which errs on the side of
waiting.

A body without `Content-Length` larger than `INFLIGHT_UNKNOWN_BODY_MB` is
undercounted until it has been read. Raise it if clients send big chunked
bodies.
