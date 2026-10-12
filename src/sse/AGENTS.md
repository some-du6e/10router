# Gateway repair rules

| Rule | Enforcement |
| --- | --- |
| Parse JSON request bodies with `parseJsonObjectBody`; reject null, arrays, and primitives before reading fields. | `utils/requestBody.js` and `tests/unit/gateway-request-validation.test.js` exercise seven handler entrypoints. |
| Respect TTS body `response_format`, with an explicit query format taking precedence. | `tests/unit/gateway-tts-response-format.test.js` verifies the format passed to the executor and the response media type. |

Run from `tests/` with `npx vitest run unit/gateway-request-validation.test.js unit/gateway-tts-response-format.test.js`. Both suites also run in deterministic regression CI.
