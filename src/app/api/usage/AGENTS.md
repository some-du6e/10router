# Usage API checks

Run the focused check from `tests/` before changing the usage stream.

| Rule | Enforcement |
| --- | --- |
| Usage SSE owns one cleanup path for request abort, body cancellation, read failure, and enqueue failure. Check closed state after asynchronous reads before enqueueing or attaching listeners. | `npx vitest run unit/usage-stream-lifecycle.test.js` verifies delivered stats, listener and timer disposal, initial failures, and disconnects during initialization. All six regressions fail against `0cc95595c`. |
