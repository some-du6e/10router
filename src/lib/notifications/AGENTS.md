# Notification delivery checks

Notification senders use `notificationFetch` to own destination validation, HTTP timeouts, and response cleanup. Senders only use HTTP status; returned response bodies are disposed.

| Rule | Enforcement |
| --- | --- |
| Cancel unread response bodies before closing the pinned dispatcher, including successful responses, rejected redirects, and interrupted error-body reads. A failing cancel must not skip dispatcher shutdown. | `.github/workflows/usage-stream-notifications.yml` runs `unit/notification-response-lifecycle.test.js` and `unit/quota-notifications.test.js`. |
