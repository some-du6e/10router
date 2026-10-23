# OAuth regression rules

| Rule | Owner and enforcement |
| --- | --- |
| Extract Codex email, workspace and plan through `extractCodexAccountInfo(idToken, accessToken)`. ID-token claims take precedence; missing claims fall back to the access token. JWT decoding supplies metadata, not authentication. | `providerHelpers.js`; `tests/unit/oauth-codex-identity.test.js` exercises OAuth mapping and both import routes. |
| Retain a successful token refresh even when the following connection probe rejects or throws. Never retry Cline with an old refresh token after proactive rotation. | `testOAuthConnection` in `src/app/api/providers/[id]/test/testUtils.js` owns refreshed credentials; `tests/unit/oauth-probe-refresh-persistence.test.js` checks persistence through `testSingleConnection`. |
