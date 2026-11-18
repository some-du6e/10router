# CLI launcher rules

Paths are relative to the repo root.

| Rule | Enforcement |
| --- | --- |
| The launcher manages only the server child it spawned. Never kill a process found by name or by port. Before each start, `checkPortFree` refuses when anything answers on the dial address or the bind fails, and the launcher exits with a message saying what to do. | `cli/src/cli/utils/serverSupervisor.js`, `cli/src/cli/utils/serverProcess.js`; `tests/unit/cli-launcher-lifecycle.test.js` |
| The supervisor restarts a crashed server at most `MAX_RESTARTS` times (2, in `cli/src/cli/utils/serverSupervisor.js`): the third quick failure in a row ends the launcher. A run of `RESTART_RESET_MS` resets the count. `start()` never rejects. | `tests/unit/cli-launcher-lifecycle.test.js` ("launcher server supervisor") |
| Never signal a child that has exited: its PID may be reused. Every exit path, Ctrl+C in the raw-mode menu included, goes through `killServer`. | `killServer` in `cli/src/cli/utils/serverProcess.js`, `interrupt` in `cli/src/cli/utils/input.js`; `tests/unit/cli-launcher-lifecycle.test.js` ("stopping our own server") |
| One launcher per DATA_DIR. `<DATA_DIR>/launcher.lock` holds the holder's PID and process start time, is created by hard-linking a fully written temp file, and a stale one is renamed aside and re-checked before removal. `killAppProcesses` removes it when it kills that launcher. | `cli/src/cli/utils/dataDirLock.js`, `src/lib/appProcesses.js`; `tests/unit/cli-data-dir-lock.test.js`, `tests/unit/app-updater-kill-sweep.test.js` |
| Readiness means our own child is alive and answering, so the CLI token never goes to a port occupant. It gives up after 120 s with a message. | `waitServerReady` in `cli/src/cli/utils/serverProcess.js`; `tests/unit/cli-launcher-lifecycle.test.js` |
| Tray relaunch and autostart entries are built from `getBackgroundArgs` and carry `--host`, `--port`, `DATA_DIR` and `TENROUTER_AUTOSTART=1` on every platform. `enableAutoStart` never runs `launchctl`. `--host` and `--port` are validated once, at parse time. A DATA_DIR from an autostart entry must be owned by the user and not group/other-writable. | `cli/src/cli/utils/launchArgs.js`, `cli/src/cli/tray/autostart.js`; `tests/unit/cli-autostart-bind.test.js`, `tests/unit/cli-data-dir-lock.test.js` |
| The dashboard update relaunch keeps the bind only when the launcher in the env is the server's parent and HOSTNAME passes the same host check. | `src/lib/appUpdater.js`; `tests/unit/app-updater-relaunch.test.js` |
| Server stdout and stderr are piped and decoded as UTF-8 streams: only the setup-token banner reaches the terminal (and stays in the menu header until setup consumes the token), everything else goes to the crash log. `--log` shows all of it. | `attachServerOutput` in `cli/src/cli/utils/launchArgs.js`; `tests/unit/cli-launcher-lifecycle.test.js` ("server output") |

Run from `tests/` with `./node_modules/.bin/vitest run unit/cli-launcher-lifecycle.test.js unit/cli-data-dir-lock.test.js unit/cli-autostart-bind.test.js unit/app-updater-relaunch.test.js unit/app-updater-kill-sweep.test.js`. CI runs all of them in `.github/workflows/security-local-host.yml`.
