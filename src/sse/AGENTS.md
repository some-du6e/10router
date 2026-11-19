# Gateway repair rules

| Rule | Enforcement |
| --- | --- |
| Parse JSON request bodies with `readJsonObject`; reject null, arrays, and primitives before reading fields. Chat calls it inside its memory admission and passes the ticket, so the body is read only after admission and its length is counted. | `utils/requestBody.js` and `tests/unit/gateway-request-validation.test.js` exercise seven handler entrypoints; `tests/unit/memory-admission.test.js` covers chat's admission. |
| Respect TTS body `response_format`, with an explicit query format taking precedence. | `tests/unit/gateway-tts-response-format.test.js` verifies the format passed to the executor and the response media type. |

Run from `tests/` with `npx vitest run unit/gateway-request-validation.test.js unit/gateway-tts-response-format.test.js`. Both suites run in `.github/workflows/gateway-request-validation.yml`.
