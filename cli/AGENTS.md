# CLI repair rules

| Rule | Enforcement |
| --- | --- |
| Manage only the launcher-owned server child; recovery must stop after shutdown and avoid overlapping starts. | `tests/unit/cli-launcher-lifecycle.test.js` exercises retries, shutdown, and unrelated-process safety. |
| Build tray relaunch and autostart arguments with `getBackgroundArgs` so host and port survive on every platform. | `src/cli/utils/launchArgs.js` and `tests/unit/cli-autostart-bind.test.js`. |
| Keep first-run server output visible so the setup token can be read without `--log`. | `tests/unit/cli-launcher-lifecycle.test.js`. |

Run from `tests/` with `npx vitest run unit/cli-launcher-lifecycle.test.js unit/cli-autostart-bind.test.js`. Both suites also run in deterministic regression CI.
