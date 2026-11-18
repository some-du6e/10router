# CLI launcher rules

| Rule | Enforcement |
| --- | --- |
| The launcher manages only the server child it spawned. Never kill a process found by name or by port. Before each start, `checkPortFree` refuses when anything answers on the dial address or the bind fails, and the launcher exits with a message saying what to do. | `src/cli/utils/serverSupervisor.js`, `src/cli/utils/serverProcess.js`; `tests/unit/cli-launcher-lifecycle.test.js` |
| The supervisor restarts a crashed server at most `MAX_RESTARTS` times (2, in `serverSupervisor.js`): the third quick failure in a row ends the launcher. A run of `RESTART_RESET_MS` resets the count. | `tests/unit/cli-launcher-lifecycle.test.js` ("launcher server supervisor") |
| Never signal a child that has exited: its PID may be reused. Every exit path, Ctrl+C in the raw-mode menu included, goes through `killServer`. | `killServer`, `interrupt` in `src/cli/utils/input.js`; `tests/unit/cli-launcher-lifecycle.test.js` ("stopping our own server") |
| One launcher per DATA_DIR (`<DATA_DIR>/launcher.lock`). Readiness means our own child is alive and answering, so the CLI token never goes to a port occupant. | `src/cli/utils/dataDirLock.js`, `waitServerReady`; `tests/unit/cli-launcher-lifecycle.test.js` |
| Tray relaunch and autostart entries are built from `getBackgroundArgs` and carry `--host`, `--port` and `DATA_DIR` on every platform. `enableAutoStart` never runs `launchctl load`. `--host` is validated once, at parse time. | `src/cli/utils/launchArgs.js`, `src/cli/tray/autostart.js`; `tests/unit/cli-autostart-bind.test.js` |
| Server stdout is piped: only the setup-token banner reaches the terminal, everything else goes to the crash log. `--log` shows all of it. | `createServerOutput`; `tests/unit/cli-launcher-lifecycle.test.js` ("server output") |

Run from `tests/` with `./node_modules/.bin/vitest run unit/cli-launcher-lifecycle.test.js unit/cli-autostart-bind.test.js unit/app-updater-relaunch.test.js`. CI runs all three in `.github/workflows/security-local-host.yml`.
