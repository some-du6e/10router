# Notification delivery checks

Notification senders use `notificationFetch` to own destination validation, HTTP timeouts, and response cleanup. Senders only use HTTP status; returned response bodies are disposed.

| Rule | Enforcement |
| --- | --- |
| Cancel unread response bodies before closing the pinned dispatcher, including successful responses, rejected redirects, and interrupted error-body reads. | From `tests/`, run `npx vitest run unit/notification-response-lifecycle.test.js unit/quota-notifications.test.js`. The three lifecycle regressions fail against `0cc95595c`. |
