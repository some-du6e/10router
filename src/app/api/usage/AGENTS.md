# Usage API checks

Run the focused check from `tests/` before changing the usage stream.

| Rule | Enforcement |
| --- | --- |
| Usage SSE owns one cleanup path for request abort, body cancellation, read failure, and enqueue failure. Check closed state after asynchronous reads before enqueueing or attaching listeners. | `.github/workflows/usage-stream-notifications.yml` runs `unit/usage-stream-lifecycle.test.js`, which covers delivered stats, listener and timer disposal, initial failures, and disconnects during initialization. |
