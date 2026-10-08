# 10router tests

The test package covers the dashboard, gateway, translators, providers, auth, persistence, and CLI helpers.

## Setup

Install root dependencies first, then the test runner:

```bash
npm install
cd tests && npm install
```

## Commands

Run the deterministic Vitest suite from `tests/`:

```bash
npm test
```

Other suites are opt-in:

```bash
npm run test:live       # provider/network checks; requires credentials
npm run test:e2e        # running local server and E2E credentials
npm run test:benchmark  # DB benchmark
npm run test:stress     # DB concurrency and stress checks
npm run test:cloud      # cloud-worker tests; requires the cloud sources
```

The default suite excludes live provider calls, E2E tests, benchmarks, stress tests, and cloud-worker tests. The live MiMo checks require `RUN_MIMO_FREE_LIVE_TESTS=1`; `test:live` sets it automatically.

Local cache-accounting integration tests run in the default suite. The live and E2E launchers set their environment flags through Node, so the npm commands also work with Windows's default shell.
