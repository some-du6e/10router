# CLI launcher rules

| Rule | Enforcement |
| --- | --- |
| The launcher manages only the server child it spawned. Don't kill processes found by name or by port: a port held by something else stays with its owner, and the launcher gives up after `MAX_RESTARTS`. | `src/cli/utils/serverSupervisor.js`, `tests/unit/cli-launcher-lifecycle.test.js` |
| Build tray relaunch and autostart arguments with `getBackgroundArgs` so host and port survive on every platform. | `src/cli/utils/launchArgs.js`, `tests/unit/cli-autostart-bind.test.js` |
| Server stdout stays visible without `--log`, because the first-run setup token is printed there. | `serverStdio` in `src/cli/utils/launchArgs.js` |

Run from `tests/` with `./node_modules/.bin/vitest run unit/cli-launcher-lifecycle.test.js unit/cli-autostart-bind.test.js`. CI runs both in `.github/workflows/security-local-host.yml`.
