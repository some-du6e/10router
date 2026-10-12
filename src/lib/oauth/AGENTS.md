# OAuth regression rules

| Rule | Owner and enforcement |
| --- | --- |
| Extract Codex email, workspace and plan through `extractCodexAccountInfo(idToken, accessToken)`. ID-token claims take precedence; missing claims fall back to the access token. JWT decoding supplies metadata, not authentication. | `providerHelpers.js`; `tests/unit/oauth-codex-identity.test.js` exercises OAuth mapping and both import routes. |
