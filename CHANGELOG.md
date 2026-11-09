# Unreleased

## Fixes
- **The endpoint page's model check no longer says "The key was rejected" while the keys work.** It skipped every key with its own URL, so on an endpoint where each key sits on its own account it had no key left and probed the endpoint's URL with none. It also stopped at the first switched-on key, even a dead one. Now it tries up to 5 switched-on keys with a credential, in priority order, the ones on the endpoint's URL first, and asks a key with its own URL at that URL. It moves on after a refusal or a rate limit (on the free probes or the model probes), and after any failure of a key with its own URL, since the next account's server may be fine. Detection now says itself whether the key got through, was refused, was rate-limited or told nothing, and the check goes by that. A refusal that only shows once models are asked about counts (it used to read as "nothing changed"). A key limited to other models still counts as working. A run whose model checks were cut short by time or server errors gets the next key tried; if none does better it is shown, with why the checks stopped. A key the bad-key check proved stays good when its model checks are refused or cut short. A refusal by GET /models alone no longer blames the key; the next key gets a try, and when the API paths answer 5xx the endpoint is reported as down rather than the key as rejected (in Add endpoint too). A public model list that refuses the key counts against it. With a saved key header (`x-api-key`, `api-key`), the bad-key check now really sends a made-up key, so a working key can be proved. On a client-gated endpoint, a key that gets past the gate as a known client and is then refused counts as refused, not as "only accepts specific clients", so the next key gets its turn. The client-identity search stays inside the shared budget too. All the keys share one 45-second budget, so the page doesn't give up first. When several keys were tried and none worked, it says how many and what the first one got; with no usable key it says the endpoint needs one. A result from a key with its own URL only offers what holds for the whole endpoint: new models it serves on the endpoint's API, outdated ones and the API type (left unticked), but not that key's URL, its fixes (auth header style, `max_completion_tokens`), removal of models missing from its list or per-model routes, and the page says it was checked through one key's URL. When other keys didn't get through, the page says how many, so a dead key that is still switched on shows up. A cut-short check, including one where the made-up-model check got a 5xx, no longer moves a saved route off an API it didn't finish checking, and says why it stopped. An offer to clear routes the endpoint no longer needs now shows as a fix to tick instead of a change with nothing to pick. The error no longer ends in two periods.
- **The Codex ingress (`/backend-api/codex/*`) now needs a key from outside, like `/v1`.** The gateway guard didn't list it, so a remote request reached the route with no key check at the gateway. It now gets the same check as the other inference routes: loopback as before, a valid client key from anywhere else.
- **A slow upstream no longer gets a non-streaming request killed with a Cloudflare 524.** Claude Code falls back to a `stream: false` request when a stream comes back empty or keeps failing, and the Anthropic and OpenAI SDKs send one for any `create()` call without streaming. Those got no early headers, so an upstream that hung for 92 seconds and then failed, followed by the next key answering, passed Cloudflare's 100-120 second wait with nothing sent, and the user got a 524. Now a non-streaming request on `/v1/messages`, `/v1/chat/completions` or `/v1/responses` with no answer after 30 seconds gets 200 and `Content-Type: application/json`, then a newline every 15 seconds while fallback carries on, then the JSON reply. Leading whitespace is valid JSON, and the Anthropic SDK, the OpenAI SDK and Claude Code parse it. When every option fails after the 200 went out, the body is the API's own error: Anthropic `{"type":"error","error":{…}}`, OpenAI `{"error":{…}}`, and a `status: "failed"` Response for `/v1/responses`. The SDKs return that as the result rather than throwing (they only look at the status), and Claude Code reports it as "API returned an empty or malformed response (HTTP 200)" without retrying. A reply that breaks halfway cuts the connection, so the client sees an error rather than half a JSON body. Requests answered within 30 seconds are unchanged, real status and headers included. A request with no `stream` field counts only when it sends `Accept: application/json` (as the SDKs do), since otherwise the provider decides whether the reply is a stream. `NON_STREAM_EARLY_HEADERS_MS` changes the wait for these requests only, and `0` turns it off. When it is unset it follows `STREAM_EARLY_HEADERS_MS`, so `STREAM_EARLY_HEADERS_MS=0` turns it off too; `STREAM_KEEPALIVE_MS=0` always does.
- **A slow upstream no longer gets a streaming request killed with a Cloudflare 524.** Cloudflare gives up with a 524 when the origin sends no response headers for about 100-120 seconds, and 10router sent none until an upstream answered, so an upstream that took 198 seconds to start (or several slow accounts in a row) failed Claude Code with `API Error: 524`. Now an OpenAI chat, Anthropic messages or Responses stream that has no upstream answer after 30 seconds gets 200 and SSE headers at once, then `: keepalive` comments every 15 seconds while account and combo fallback carry on as before. When an upstream answers, its stream follows. When every option fails, the error goes into the stream in the client's own format: Claude `event: error` (`overloaded_error` for a 409, 429, timeout or 5xx, which Claude Code retries), Responses `response.failed` (a code Codex retries, or `invalid_prompt` for a final error, which Codex shows as is, so the "Next account resets in …" countdown survives), and an OpenAI `data: {"error": …}` then `[DONE]`. A stream that breaks without its own terminal error now ends with one too. Requests that fail within 30 seconds still get their real HTTP status. Set `STREAM_EARLY_HEADERS_MS` to change the wait, or to `0` to turn it off (`STREAM_KEEPALIVE_MS=0` turns it off too). Other client formats never get early headers; non-streaming requests get them as JSON (see the entry above). Claude Code retries an in-band `overloaded_error` on the stream only twice, then resends the turn with `stream: false`; set `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` on the client to keep it on the stream (see `docs/FAST_FAIL.md`). Claude Code and Codex give up on a stream that has carried only keepalive comments for about 5 minutes (Codex then sends the turn again from the start), so routing that can take longer than that after the early headers needs `CLAUDE_STREAM_IDLE_TIMEOUT_MS` or Codex's `stream_idle_timeout_ms` raised on the client. Separately, on every chat request, streaming or not and on every route (Ollama, Gemini and the Codex ingress included), a client that hangs up now cancels the upstream request, and no other account or combo model is tried, no account is locked for it, and no rate-limit hold starts or keeps waiting.
- **The Usage → Details table names custom endpoints, shows the key, and keeps itself up to date.** Rows from a custom endpoint showed its generated id (`openai-compatible-chat-…`) instead of its name, such as "Snowflake". The server now labels each row, so the name no longer depends on a lookup in the browser. A new Key column (also in the drawer) shows which upstream key served the request, and a Status column shows failures. Page 1 refreshes every 5 seconds while the tab is visible; the button above the table turns that off, and a failed refresh now says so above the table instead of leaving old rows up silently. The list now loads without the request and response payloads (a page was about 4.6 MB), and the drawer fetches one request's payloads when you open it.
- **Streams that go quiet no longer get cut at about 100 seconds behind Cloudflare.** Cloudflare drops a proxied connection after about 100 seconds with no bytes, so a Claude Code subagent waiting on long thinking or a big tool call was cut long before 10router's own 6-minute stall limit. After 15 seconds with no output, 10router now writes an SSE comment (`: keepalive`), which clients ignore. It goes only to OpenAI chat, Anthropic messages and Responses streams, never in the middle of an event, and it doesn't count as upstream activity, so a stream that is truly stuck still ends at the stall limit. Set `STREAM_KEEPALIVE_MS` to change the interval, or to `0` to turn it off.
- **A timeout setting above about 24.8 days no longer fires at once.** Values that large overflow Node's timer, which fired after 1ms, so an oversized `STREAM_STALL_TIMEOUT_MS` ended every stream immediately. `STREAM_STALL_TIMEOUT_MS`, `STREAM_FIRST_CHUNK_TIMEOUT_MS`, `FETCH_CONNECT_TIMEOUT_MS` and `GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS` now fall back to their default instead.
- **A key demoted on a model says so on the dashboard.** A key demoted after repeated 403s on a model stays on, and its row showed only "unverified" and the raw 403, so it looked like a dead key that never got switched off. The provider pages and the custom endpoint page now show "Demoted on <model>", and hovering it shows the refusal for each model. The "<model> demoted after repeated …" error is no longer shown while the label is, nor after the demotion ends (a success on the model, or switching the key back on). Switching a demoted key off and back on clears the label right away, as it does on the server.
- **A 2-second rate limit no longer shows up as "Failed to authenticate".** When every key was locked at once, say a dead key on a long lock and the working key on a 2s rate limit, clients got the dead key's 403 instead of a 429, and Claude Code gave up instead of waiting a second and retrying. Two things caused it: the error came from whichever key was listed first, and a 401/403 the same request had just hit on the dead key beat the working key's 429. Now the error comes from the soonest key locked for a rate limit on the requested model, even if a dead key frees up first, and otherwise from the key that frees up first. A key with no stored error, such as one blocked only on quota, is picked last. A key keeps only its last error across all models, so where that error contradicts the lock on the requested model it is not used: a rate-limited key whose last error was a 403, 400 or other non-limit error on another model reports a 429, and a key refused here whose last error was a 429 or 5xx elsewhere doesn't turn the 403 into that retryable code. A rate-limited key with no error stored reports a 429. A 401/403 that only reads like a quota error (a 403 with no body says "You exceeded your current quota") still counts as a refusal, and a plan limit such as GitHub's 402 keeps its own code and message. A request that hit a 401/403 gets the retryable 429 or 5xx, with that key's message, when the reported key is locked for a rate limit on the requested model (a lock from a plain 5xx can't be told from a refusal's, so it keeps the 401/403 as before); in chat it also gets one when another key hit a 429 or 5xx in the same request. The retry time counts only locks on the requested model, so a short lock on another model no longer says "retry in 1s".
- **One burst of rate limits no longer locks a key out for minutes.** When several requests already on their way all came back with a 429 (or another rate-limit or overload error), each one raised the key's backoff a step, so a 32-second lock became 4 minutes and the only key sat idle while every request was turned away. Now an error that lands while the key is already locked (on that model or account-wide) keeps the current step: the lock runs to its existing end or one cooldown at the current step, whichever is later, and keeps its reset time. Only an error after the lock runs out raises the step. An account-wide lock is also no longer missed when the model's own lock has expired, and "all your accounts have hit their limits" now looks only at locks still in force.
- **Claude Code 2.1.312 auto mode works on Snowflake Cortex again.**
  - Requests no longer fail with `400 safeguards: Extra inputs are not permitted`. Auto mode adds a `safeguards` field holding Claude Code's classifier input (permission rules, paths, git state). Hosts other than `api.anthropic.com` no longer get it or its `dangerous-tool-use-2026-09-03` beta. A relay whose URL only contains that name still counts as another host.
  - To send it to such an endpoint anyway, add an `anthropic-beta` header line with `dangerous-tool-use-2026-09-03` in the endpoint's Advanced settings, or list that beta in a custom client preset. With that beta going out, `safeguards` goes out too. Without it, the field is dropped, even when it was added by a body merge. The line replaces the betas Claude Code sent (`context-1m`, `context-management`, `effort`, `interleaved-thinking`, …), so list every flag the endpoint needs on it.
  - The `claude` and `anthropic` providers don't send `safeguards`, since their fixed beta lists don't include its beta.
  - When an upstream call fails, the saved request log shows the body as it would have been sent, so it doesn't keep a `safeguards` field the request would have dropped. The dashboard's Translator preview shows that body too.
- **Dead API keys turn themselves off**: an API key that keeps getting 401s or 403s is switched off after 10 minutes (an hour if, for any of its counted failures, the only keys serving that model were on a different upstream), instead of being tried first again every time its lock expires. OAuth accounts and session cookies are never switched off. These never count, whether they come as a 401 or a 403: limits, rate limits and overload; billing, balance and plan blocks (qoder's "Queue limit", a pricingUrl, "account balance is insufficient", `AccountOverdueError`); refusals of one model ("does not have access to model", `model_not_found`); and a restricted key refused one operation ("insufficient permissions", "Missing scopes"). A failure only counts if another key of the same provider, behind the same proxy, served that model and was not refused on it since this key last failed on it (for its first failure on that model, within the last 10 minutes). So an outage that hits every key, all the time or only some of the time, turns none off. It takes 5 such failures, and either they're all 401s or they (401s or 403s) cover at least 2 models. They have to span 10 minutes if every failure had a serving key on the same upstream (base URL, Azure endpoint, region, location, account or project), and an hour otherwise, since a key on its own server may be refused because that server is down. A gap longer than that window starts the count over, so the hour-long count survives the pauses of someone stepping away. When the hour-long count has had gaps over 10 minutes, it trips once the failures since the last such gap span the hour on their own, or once it has 2 bursts (2 or more failures with no such gap) and spans the hour. So a few failures spread thinly across an hour, or one burst followed by them, don't turn a key off. The last active key of a provider is never switched off. Pasting a different key starts the count over, and a failure from a request sent with the old key is not held against the new one. A TTS or speech-to-text success now clears a key's errors the way a chat success does, and a success no longer rewrites the connection every time once a model lock has been cleared, while still clearing a reset time, limit flag or error code that a manual lock or cooldown clear left behind (so a working account doesn't keep its Re-auth button). The key shows "Turned off automatically" with the error on the provider and endpoint pages. Switching it back on, or pasting a different key into its edit dialog, brings it back; a passing connection test does not, and "Test all" skips it, on the custom endpoint page too, which now also skips keys turned off by hand.
- **A key that keeps refusing the only model in use is tried last on it.** A 403 on one model can mean the key lacks only that model, so instead of being switched off the key is demoted on that model, and other keys are tried first. It stays on and keeps serving every other model.
  - **What counts:** 403s on that model that the rule above would count, and 403s saying the key may not use that model ("does not have access to model", `model_not_found`, "model … not available", in any letter case). Limit, quota, billing, plan, overload and permission refusals never count, and like the rule above, a refusal only counts if another key served that model. 401s don't count; the rule above handles them. Refusals of just one model are remembered apart from the rule above, so it weighs its own evidence exactly as before.
  - **When:** 5 of them spanning 10 minutes, or an hour if any had only a key on another upstream serving. A pause over an hour starts the count over. Only a success on that model clears the count, not one on another model. A key also refused on another model within that window, in a way the rule above counts and with no success since, is left to that rule.
  - **Probes:** a demoted key still gets one real request on that model 10 minutes after the demotion. Every counted 403 on that model while demoted, a probe or a fallback use, waits longer for the next probe: 20 minutes, 40 minutes, 1.5 hours, then every 3 hours. A probe that gets no counted refusal (a rate limit, a server error, a dropped request) is tried again 10 minutes later at the same interval. At most one probe goes out per 10 minutes, across requests and processes, and restarts keep the schedule. With fill-first, a demoted key behind another usable key (a backup) isn't probed, since it wouldn't be tried anyway. A success on that model, from a probe or otherwise, lifts the demotion.
  - **Dead on every model:** a key demoted on a model for refusals the rule above counts, which served nothing from 10 minutes before that count began until now (each key's first success after the router starts is saved once, so this holds across restarts), is switched off as above, with both models in the reason, when another model refuses it in a way the rule above counts:
    - within 10 minutes of a previous such refusal on that model, and of its last refusal on the demoted model;
    - or in the refusal that demotes it there too, within the first demotion's probe interval plus 10 minutes;
    - or when the demoted model's probe is refused within 10 minutes of the other model's refusal. A refusal on another model makes that probe due at once, though still at most one per 10 minutes.
    - So a backup key that lacks one model (with wording not recognised as such), used only when the main key is busy and idle for over 10 minutes before that model's refusals began, can be switched off by one refusal on another model followed by its refused probe.
  - **Still used when needed:** if no other key can serve the model, the demoted key is used anyway, with its normal 2-minute cooldown.
  - **Clearing it:** a different key, switching the key off and on, or clearing that model's cooldown clears the demotion.
  - **Shown:** `/api/models/availability` lists the demotion as a cooldown until the next probe, with its reason, and its Clear clears it. The key's last error reads "claude-opus-5-5 demoted after repeated 403 ..." when the demotion starts, and the log says "<key> demoted on claude-opus-5-5 after repeated 403s". A later error replaces the last-error text.
  - **Typical timing:** a key used only for opus in 10-minute sessions is demoted within about 25 minutes (70 with only a key on another upstream serving). After that it's tried about 3 times in the next hour, then once every 1.5 to 3 hours. After a refusal on one model passes, the key is back on it within one probe interval: minutes after a short incident, at most 3 hours after a long one.
- Adding a key to a custom endpoint can set that key's own URL right away. Click "Use a different endpoint URL for this key" under the name field. Before, the URL could only be set by editing the key after adding it.
- Claude Code thinking summaries are no longer empty on Snowflake Cortex (and other routes that translate Claude Code requests). Claude Code ends each request with a `role: "system"` reminder, and the router treated that as "the last turn isn't the user's" and deleted `thinking`, along with its `display: "summarized"`. Trailing system turns are now skipped when deciding whose turn it is.
- Thinking requests for Claude Sonnet 5.5 no longer fail with `400 "thinking.type.enabled" is not supported for this model`. For models that only take adaptive thinking (Sonnet 5.5, Opus 5.5, Haiku 5.5, Fable, Mythos, and the dated or prefixed ids of Opus/Sonnet/Haiku 5), `thinking: {type: "enabled", budget_tokens}` is rewritten to adaptive thinking plus `output_config.effort`, with the effort picked from the budget. An effort the client already set is kept. This covers Claude clients, OpenAI `reasoning_effort` and Responses `reasoning.effort`. `thinking.display` (`summarized` or `omitted`) is kept on the rewritten request. Effort `minimal` is sent as `low`, since Anthropic has no `minimal`. Native passthrough no longer downgrades adaptive thinking on Haiku 5.5.
- Claude Code requests for Claude models on Snowflake Cortex no longer fail with `400 context_management: Extra inputs are not permitted`. When a custom endpoint's Anthropic route drops the `context-management-2025-06-27` beta (Strip beta, a flag the endpoint rejected before, or the retry after a rejection), the `context_management` field it unlocks is dropped from the body too.
- Re-detect on an endpoint page now says what it's doing while it runs: which step it's on, how many models it has checked and how many work, requests sent, time taken, and any rate-limit wait. A Stop button cancels it, and leaving the page cancels it too.
- Endpoints with no model list (Snowflake Cortex) now find the newest models (Claude Opus/Sonnet/Haiku 5.5, GPT-6, Kimi K3, GLM 5.3) and stop adding releases the labs have moved on from, like Claude Opus 4.5 or GPT-4.1. The Models card's refresh offers to remove outdated models already saved.
- The endpoint page shows one badge per API the endpoint answers on, not just the main one.
- Endpoint icons come out sharp: a tiny favicon on the API host is passed over for the company's full-size app icon, and see-through logos get padding so the rounded corners don't cut them off.
- The logo on the login page is now the same mark as the sidebar. The old hand-drawn version had uneven spokes that ran into the center ring.
- **No Claude Code prompt on API providers**: requests translated to Anthropic API keys and Anthropic-compatible gateways (e.g. MiniMax) no longer get "You are Claude Code, Anthropic's official CLI for Claude." added to the system prompt. Only the Claude Code login provider and Anthropic OAuth tokens still send it. The line is now sent once, as its own first system block, and Antigravity strips it so its competing-branding check does not 429 the request.
- Custom endpoint cards on the providers page now match the other provider cards: a letter badge instead of a borrowed OpenAI/Anthropic logo, a key count, and one pill per API the endpoint answers on. Existing endpoints switch over automatically.
- Chrome no longer offers saved Google passwords on API key and token fields (the URL field in Add endpoint was being treated as a username). Key fields are masked text boxes now, so Chrome sees no login form. Real login password fields are unchanged.
- Requests that leave out `stream` now get plain JSON back when the upstream answers with JSON (Anthropic-style APIs, Snowflake Cortex), instead of that JSON followed by a stray `data: [DONE]`. Clients that ask to stream get the finished reply replayed as SSE in their own format (OpenAI, Claude, Responses).
- **Tool calls no longer dropped on OpenAI-style paths**: when an upstream ends a Chat Completions stream without `finish_reason` (Snowflake serving Claude), the reply to Claude clients now closes properly and reports `tool_use`, so Claude Code runs the tool instead of seeing a cut-off turn.
- On custom endpoints, a 400/404/422 caused by the request (bad body, unknown model) tries the next key without locking any key. Built-in providers keep their short locks.
- Endpoint detection's api-key header result is now saved as the endpoint's api-key quirk.
- Endpoint detection no longer lists models the account can't use ("not eligible for this model", "Model ... is unavailable").
- `npm run dev` uses webpack, so TypeScript modules imported as `@/foo.js` resolve the same way they do in the build.
- **Claude Code web search picks a search provider that works**: Claude Code's WebSearch no longer falls back to SearXNG at the `localhost:8888` default, which nothing was running on. This happened when auto-combo billing ruled out every connected search provider. It now only picks SearXNG once `SEARXNG_URL` is set; explicit `/v1/search` calls and Web Search combos are unchanged. The log now says whether billing blocked a provider (add a Web Search combo to allow one) or none is set up.
- **Faster web search on non-Claude models**: Claude Code's WebSearch tool sends each search as a separate request. When that request targets a non-Claude model, 10router now answers it straight from the configured search provider instead of sending it to the model to summarize. In testing with Claude Code on `cx/gpt-5.6-luna`, that step dropped from 9–62s to under 3s. The search model lookup and repeated queries are cached for a short time, and `max_uses` is no longer read as a result count.
- Icons load from a ~46 KB font instead of the full 3.9 MB Material Symbols file, preloaded with the page. On a slow connection you no longer see raw icon names like `notifications` or `chevron_right` while it loads; a pulsing rounded square holds each icon's place until it appears. The 10router logo is now built in, so it shows straight away.
- **Wait out rate limits**: combos now wait too. Once every model in a combo is rate-limited, the whole combo waits and retries, and the first model to recover answers. Fusion combos wait when no panel model could answer. Before, hold never ran for combo traffic.
- Wait on a 429 from providers that need no login. They have no account to rotate to, so the error used to come straight back.
- Wait when every account fails on a rate limit in the same pass, not only when their locks were already recorded.
- Backups now keep each API key's rate-limit setting. Restoring one used to reset every key to the global default.
- Pick a key's rate-limit mode (Default / Wait / Fail fast) from a segmented control instead of clicking an icon that cycled through modes.
- **T3 usage hub**: preserve upstream status codes for non-JSON provider errors and reject malformed settings responses without overwriting the current hub state.

## Removed
- **Token Saver tab**: removed, with everything on it: RTK tool-output compression, Headroom, Ponytail, Caveman, and PXPIPE. On real traffic, about 94% of input tokens were already prompt-cache reads, and RTK made requests only 2.9% smaller. It also hid search results from the model: one grep returned 99 matches and the model was shown 69, with no warning. Requests now go upstream exactly as the client sent them. Saved token-saver settings are deleted on upgrade. The `x-10router-token-saver` header is ignored, and the CLI no longer has its RTK and Headroom toggles. Docker Compose no longer starts a Headroom sidecar. On first start after the upgrade, 10router stops a Headroom proxy it had started earlier and deletes the old `headroom/` and `pxpipe/` folders in the data directory. If you want any of these tools, install them in your own client.
- Remove the IDE MITM proxy, certificate and DNS interception, dashboard controls, API routes, startup hooks, and CLI/Docker packaging. Upgrade cleanup stops old proxy processes and removes their loopback hosts entries. Tailscale keeps independent encrypted elevation credentials for reboot recovery.

## Features
- **Management keys: hand out keys that can manage keys, and nothing else.** A management key (`10r-mgmt-…`, made on the Endpoint page under API Keys) calls `/api/management/v1` with a bearer token to list, create, edit and delete client keys, or to list, add and delete upstream API keys, within the scope it was given. One can be limited to adding keys for a single provider, such as a Snowflake custom endpoint, so someone can top up the pool without dashboard access. Another can create client keys only if they allow `provider/model` ids of the listed providers or models, with a budget no higher than its cap. By default a management key sees only the rows it created; "Also manage existing keys" widens that to every row inside its scope, and OAuth logins and session cookies are never in scope. A key the dashboard turned off stays off, and an expiry the dashboard set can only be moved earlier. Adding a provider key runs the dashboard's validation ping (given up on after 15 seconds) and create route, and a key the provider refuses is not added. Responses never carry provider secrets, a management secret, or a full client key, apart from a new client key's value in its create response. A token carrying a management key gets a `401` on every inference route, even from localhost, and a management key opens no dashboard API; the management API takes no session, CLI token or client key. Management keys can only be created, edited and revoked in the dashboard, which stores only the sha256 of each secret and shows it once. Revoking keeps what the key created (shown as made by a deleted management key, with a button to delete it later), or deletes it all with "Also delete everything it created". Each key can be turned off or given an expiry, and its row shows when it was last used and which client and provider keys it created. Its actions and its out-of-scope refusals go into an audit log shown on the Endpoint page; refusals are kept apart, so a flood of them can't push out the rest. Migration 006 adds the `managementKeys` and `managementAudit` tables, an `ownerManagementKeyId` column on `apiKeys` and `providerConnections`, and `disabledBy`/`expiresAtSetBy` on `apiKeys`. See `docs/MANAGEMENT_KEYS.md`.
- **API keys can have a spend budget, a model allowlist and an expiry date, and show what they've spent.** To hand someone $2,000 of Opus, open the key's limits on the Endpoint page (the tune icon), set a $2,000 budget and allow only `claude-opus-5-5`. Once the key has spent its budget, every `/v1` request with it gets a 402 before any upstream call, with an error saying the budget is used up (OpenAI `insufficient_quota` on OpenAI routes, Anthropic `billing_error` on `/v1/messages`). A model not on the list gets a 403, and an expired key a 401. `/v1/models` lists only the allowed models for that key. Each key row shows spent / budget / remaining with a progress bar, its request count and when it was last used, and the spend icon opens spend per day for 30 days, spend by model and the latest requests. Raise the budget to top a key up, or reset its spend to start it back at $0; usage history is kept either way. The person holding the key can call `GET /v1/key` with it to see its own budget, spend, remaining, expiry and allowed models, and nothing about other keys. Spend is the same per-request cost the usage page shows, kept as a running total per key, so checking it costs one indexed read per request. Requests already in flight when a key reaches its budget still finish, so a key can go over by what those cost. Keys without limits work exactly as before. A key a client sends is checked even with "Require API key" off, and the /v1 handlers now read it from the same places the gateway accepts it (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=`), so a Gemini SDK's key is checked and its spend recorded against it too. A stream the client closes before its final event is now charged (it used to record nothing): input as reported, and output at least 150 tokens per second it ran (`STREAM_ABORT_FLOOR_TPS`), since hidden thinking streams nothing visible, from the upstream's first byte to the cut (or to its last byte when it stalled), capped at the output cap actually sent upstream. A key with a budget sends requests without `speed` and `service_tier`, which bill at multiples the pricing table doesn't have. Completed streams are charged exactly what the provider reports. `STREAM_DRAIN_MAX_MS` opts budgeted keys into reading the upstream to its real final usage after a hang-up (off by default). When an upstream reports no usage, the estimated `completion_tokens` shown to the client now counts CJK and emoji at about one token per character. The Ollama route (`/v1/api/chat`) now returns errors with their real status and body instead of an empty 200. See `docs/API_KEY_BUDGETS.md`.
- **Paste a Claude Code config into Add key.** On a custom endpoint, pasting a Claude Code settings snippet (`{"env": {"ANTHROPIC_AUTH_TOKEN": …, "ANTHROPIC_BASE_URL": …}}`), a bare env object, or `KEY=value` / `export KEY="value"` lines into the API key field fills the dialog in. The key comes from `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, in that order (`OPENAI_API_KEY` first on an OpenAI-compatible endpoint and on the OpenAI provider page). A URL from `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` that isn't the endpoint's own becomes the key's own endpoint URL, with `/v1` added to `ANTHROPIC_BASE_URL` (Claude Code adds it itself), so requests go where Claude Code would have sent them. The other API's URL is used only when the paste has no key for that API, so a `.env` that sets both APIs' keys doesn't pair one API's key with the other's URL. Typographic quotes (`“…”`, `‘…’`) from a doc or chat app read like ASCII quotes. A key given as a reference (`ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY`, `${…}`, `%…%`, `$env:…`), as in OpenRouter's and DeepSeek's guides, is read from that variable when the paste sets it; otherwise the field asks for the key instead of saving the reference. A line under the field says what was filled, names a `*_BASE_URL` it couldn't use (not an http(s) URL; the key then uses the endpoint's URL, clearing one an earlier paste set), and counts the other variables ignored, never their values. Nothing is saved until you click Add key, and a normal key pastes as before, as does a shell one-liner such as `ANTHROPIC_AUTH_TOKEN=… claude`. The built-in provider pages take the key from such a paste too.
- **Each active key shows roughly how much life it has left.** Keys of some providers die every few hours to days, and the first sign was failed requests. The provider pages, the custom endpoint page and the media provider pages now label each active key, for example "~58% left · ~9h at current pace". The estimate comes from the provider's earlier keys that were turned off automatically: what each one consumed in successful requests before it died, as cost, or as tokens when one of them has no cost. Chat, embeddings and System One requests count. TTS, image and speech-to-text requests record no usage, so keys used only for those get no label. The label uses the median of those, so a key at $230 where earlier keys died at $419 to $717 (median $552) reads 58% left. The time is the remaining budget at the key's pace over the last 6 hours, and is left out when the key has been idle. Hovering shows the amount used, the typical budget, the range most earlier keys fell in, and how many keys it's based on. Dead keys that never served anything, and keys that died below a quarter of the median (such as one whose account was locked), are left out. With fewer than 3 dead keys left, no label is shown. A key whose models have no price, on a provider measured in cost, gets no label rather than a "100% left" that never moves. Only API keys get turned off automatically, so OAuth and cookie accounts on providers that also take API keys get no label and are not counted. Pasting a new key into an existing connection, or re-adding a key under the same name, starts its count from zero, so it doesn't inherit the old key's spend. If the old key had been turned off automatically, it still counts as a dead key, so replacing keys in place builds up the estimate too. It works the same for every provider. The numbers come from `GET /api/providers/lifespan?provider=<id>`, which returns only key ids and numbers, and is cached for a minute or until the provider's keys change. It runs grouped queries on a new covering index on `usageHistory`, `idx_uh_conn_ok`. Each dead key is read once, 10 minutes after it died, and later refreshes read only the active keys, so the cost doesn't grow as dead keys pile up. Active keys are read only when the dead keys give an estimate, so a provider with fewer than 3 usable dead keys never scans its active keys' history. Amounts under a cent, in the tooltip and on the account page, now show two significant digits ($0.004) instead of $0.00.
- **Failed requests say why they failed.** Each failed request in the request log now records what kind of failure it was: `rate_limited` (rate limits, quota, credits, billing, plan limits, 402s, and an overloaded or out-of-capacity upstream, such as a 529 `overloaded_error`), `auth_error` (bad or expired key, or a key not allowed to do that), `client_error` (a bad request, or no access to that model), `upstream_5xx`, `timeout`, `network_error` (the upstream couldn't be reached), `aborted` (the client hung up), or `other`. It uses the same wording lists that decide when an account cools down or a key is turned off, so a 403 for running out of credits counts as a rate limit, not an auth error.
  - Failed requests that got an answer from the upstream now show a real TTFT: the time until the upstream's final response headers arrived, including any retries and waits between them. It stays 0 when the upstream never answered.
- **Auto combos**: send a bare model id like `claude-opus-5-5` and 10router falls back across every connected provider serving it, free and subscription providers first, with no combo to set up. Dots and case are ignored when matching (`claude-opus-5.5` counts). A combo or alias by that name still takes over. Under Profile → Auto Combos you pick which kinds of provider it may use: subscriptions, free, custom endpoints, free tiers, pay per token. Only subscriptions and free providers are on by default. An OAuth provider connected with an API key counts as pay per token, and so do Cline and Kilo Code, which spend prepaid credits. Billing is checked per account: with both a login and an API key for one provider, an auto combo only ever uses the allowed one, even when the first is rate-limited. Auto combos fall back in order rather than following your global combo strategy, unless you set a strategy for that model name. A bare id never reaches a blocked account even when no auto combo forms (every provider serving it blocked, or right after startup); you get an error naming the blocked kinds instead. Claude web searches made for such a request skip providers with a blocked account too. You can also leave out single providers. Only chat traffic uses auto combos. On the Codex ingress, a model your Codex accounts serve still goes to Codex; one they don't now routes to the providers that have it rather than failing at Codex.
- **Separate model refresh**: on an endpoint page, Re-detect now only re-checks the endpoint itself (which API, the URL, fixes), and the Models card has its own refresh button that looks for new and outdated models. Before, one Re-detect button did both.
- **Load full request**: when a stored request shows `[Content truncated]`, a button on the banner loads the whole payload. The newest 25 requests keep their full payload (compressed), only while sensitive request details are enabled.
- **Add endpoint**: one button on the providers page adds an OpenAI- or Anthropic-compatible endpoint from a URL and key. 10router detects the API with free requests only (no generation), checks the key, and finds models from `/models` or, when there is none (Snowflake Cortex), from the models.dev catalog.. Custom endpoints now sit right after OpenRouter.
- **Add endpoint, the full version**: the dialog shows each request live as it runs, spins through models like a slot machine while it checks them, and ends on a clear result. Each failure has its own screen: wrong key (with Change key), key stopped working partway, host unreachable, server down, or only works as a known client. When both APIs work, it shows the models of each, grouped by maker. It can also check models it skipped, send a 1-token test message, copy the site's name and icon, and show each save step with Retry. Advanced settings cover the auth header style, acting as Codex CLI or Claude Code, and raw request overrides with a live preview.
- **Endpoint page**: icon picker (site icon, letter or upload), Send test message, Re-detect with tickable changes, Recent requests with keys hidden, a Keys card, and models grouped by maker with a switch on each.
- Providers page follows the new vendor order and drops the score badges. Endpoint cards show their icon, model count, an Unverified badge, a mask when acting as another client, and an auto-fix pill. A new endpoint slides into the grid with a short glow, and a Custom filter shows only your endpoints.
- **Two-path endpoints**: an endpoint that answers on both Anthropic Messages and an OpenAI API stays one provider, and each model goes to its best API (Claude on Messages, the rest on Responses or Chat).
- **Beta flags**: when an Anthropic-compatible endpoint rejects `anthropic-beta` values, 10router drops exactly those, retries once, and remembers them for that key and endpoint. The endpoint page's Advanced card toggles these quirks.
- **Several endpoints under one custom provider**: a key on an OpenAI- or Anthropic-compatible provider can now have its own endpoint URL, for when the same models live on another account or region (two Snowflake accounts, say). Requests to `prefix/model` fail over between the keys, and so between the endpoints. Editing the provider's URL leaves those keys' URLs alone, and the key list shows each one's host. Per-key URLs go through the same private-network checks as the provider URL.
- **Codex account limits**: automatically stop client reconnects when every usable account and fallback model has exhausted its limits. Account/model fallback and explicit rate-limit waiting still run first; temporary provider failures and interrupted streams keep normal retries.
- Show a short account-limit message with the earliest known provider reset, stored separately from retry cooldowns. Omit unknown reset times and keep per-account details in server logs.
- **Request inspector**: browse system prompts, assistant messages, tool calls and results with role filters, search, tool definitions, and text/Markdown/JSON views. The recorded assistant response appears in the conversation; provider payloads live in a collapsed Debug section. Large new request logs retain a structured preview within the configured storage limit.
- **Soonest-reset routing**: opt-in account strategy for Claude and Codex that spends the earliest weekly quota first, using session resets to break ties. Skips known exhausted accounts, preserves session affinity, and falls back to priority when quota data is unavailable. Configure it globally in Profile or per provider under Connections.
- **Quota tracker**: add provider summary bars, account search, ledger and card views, and quota details. Summaries show the average remaining per window instead of summed percentages. Status follows the tightest 5-hour, weekly or monthly window; providers with per-model pools follow their fullest pool, and unlimited rows never decide it. Hidden quota rows also leave status and summaries. The summary card slides between provider tabs. Align accounts across quota windows, count weekly-blocked capacity as empty, and retain the last reading when refresh fails. Replaces the "% quota" and "Expiring first" sorts and server-side filtering with client-side search, status filters and sorts.
- **Jev decision models**: add `/v1/systemone` with OpenCode Free, OpenCode Zen, and OpenRouter lanes, account fallback, usage tracking, and dashboard examples and model tests.
- **T3 usage hub**: opt-in CLIProxyAPI management compatibility for Codex and Claude quotas, account listing, and Codex reset credits. Enable it in Settings and create a separate management key. An isolated demo mode supplies fake subscriptions for integration testing.
- **Codex models**: add GPT-6.1 Sol with pricing, vision support, and reasoning levels through Max.
- **Model catalog**: add GPT-6 Sol and Luna, Claude Opus 5.5, and the current OpenAI and Anthropic API models with pricing, context limits, and reasoning levels. GPT-6 API requests use the Responses endpoint.
- **Codex models**: add GPT-6 Astra with its Codex context window, pricing, and reasoning levels.
- **Codex session affinity**: a Codex conversation can now be pinned to a single
  account for as long as it stays warm. The Codex executor already derives a
  stable `prompt_cache_key` from the client's `session_id`, but the upstream
  prompt cache is per-account, so re-picking an account every turn meant that key
  almost never hit — each turn re-paid the ~21k tokens of system prompt and tool
  schemas. Enable it per install with the "Session Affinity" toggle on the Codex
  CLI tool card (setting: `codexSessionAffinity`, off by default). The pin is a
  preference, not a requirement: a rate-limited, model-locked or failed account
  still falls over to another and the session rebinds. Only Codex is eligible —
  every other provider keeps per-turn selection untouched. `session_id` extraction
  now also accepts the `x-codex-session-id` / `x-codex-conversation-id` spellings
  recent Codex builds send, and separates threads of one CLI process by `thread-id`.
- **Quota notifications**: reusable named channels can now send quota-exhausted
  and quota-reset alerts through ntfy, Slack incoming webhooks, generic JSON
  webhooks, Telegram bots, or an Apprise API server. Each channel has independent
  event toggles, test delivery, secret-redacted management APIs, and explicit
  opt-in for trusted private-network destinations.
- **Codex-native endpoint**: 10router now serves `/backend-api/codex`, the base
  URL the Codex CLI/IDE expects for the ChatGPT wire (same shape codex-lb
  exposes). `POST /backend-api/codex/responses` and `/responses/compact` reuse
  the existing routing pipeline, `GET /backend-api/codex/models` serves the
  routed catalog in Codex's native `{ "models": [...] }` shape so Codex picks up
  real context windows and reasoning levels instead of its bundled metadata, and
  Codex's advisory side-calls (telemetry, thread goals, memory summarisation) are
  acknowledged instead of erroring on every turn. Clients that append `/v1` to
  the base URL are collapsed onto the same routes.
- **Codex WebSocket transport**: Codex ≥0.147 with `supports_websockets = true`
  upgrades `<base_url>/responses` instead of POSTing it, sending the Responses
  body as one `{"type":"response.create", …}` text frame and expecting the same
  event objects back, one per frame. `custom-server.js` now accepts that upgrade
  and bridges the turn through this process's own HTTP endpoint, so routing,
  auth, and fallback behave exactly as on the POST path. The frame codec is
  hand-rolled (and declines `permessage-deflate`) because this file is copied
  into the standalone output by itself — a `require("ws")` that Next's tracing
  never saw would crash the server at boot.
  Codex's startup *prewarm* connection is answered directly instead of being
  routed: it carries `request_kind: "prewarm"` and sends the full turn payload
  purely to warm ChatGPT's prompt cache, blocking the first real turn until it
  completes. Routing it upstream would spend a real model call on every session
  start and overrun the client's `websocket_connect_timeout`. There is no cache
  of ours to warm, so it is acknowledged in milliseconds.
  **Only the production server has it**: `next dev` and `next start` do not load
  `custom-server.js`, so websockets need `npm run build` + the standalone server
  (which is what Docker and the CLI launcher run).
- **Pooled Codex usage**: Codex reads its usage bar from `x-codex-*` response
  headers, which 10router previously did not send — so the bar sat empty. The
  Codex-native endpoint now reports the **pooled** figure across every connected
  Codex account, weighted by each plan's allowance
  (`Σ(capacity × used%) / Σ(capacity)`), so two Plus accounts at 60% and 20%
  show as 40% and a Pro account outweighs a Plus one. The reported reset is the
  earliest across accounts. Usage is cached and refreshed in the background, so
  no request ever blocks on it.
- **CLI Tools**: the Codex card and the launcher's Codex menu gained an endpoint
  mode. It defaults to the native endpoint — writing
  `base_url = "<host>/backend-api/codex"` with `name = "openai"` and
  `requires_openai_auth = true` — and can be switched back to the plain `/v1`
  endpoint. Re-applying settings keeps an existing config on the ingress it
  already uses.

## Fixes
- **Codex token refresh**: refresh near access-token expiry and reread persisted tokens before refreshing stale account snapshots.
- **Responses streams**: include finished output and real token usage in `response.completed`; bound the wait for missing usage to three seconds.
- **Stream failures**: emit an error event when an upstream stream aborts after HTTP 200.
- **Provider keys**: return a conflict on same-name API-key creation unless replacement is explicitly requested; append new account priorities without rewriting the pool.
- **MCP probing**: block private addresses, DNS results, and redirects for remote callers while retaining local MCP support.
- **Codex reset credits**: clear saved routing cooldowns immediately after a successful reset, invalidate pooled usage headers, and refresh account quota without waiting for the next polling interval. Usage and reset requests now target the selected ChatGPT account.
- **Claude Code web search on routed models**: Anthropic's built-in
  `web_search_20250305` tool now uses the configured 10router web-search
  provider when Claude Code is routed to a non-Claude model. Search sources are
  injected into the model context while ordinary client tools remain intact;
  native Claude requests continue to use Anthropic's server-side tool.

# v0.6.0 (2026-08-11)

## Changed
- **Rebrand**: the project is now **10router** (fork of
  [decolua/9router](https://github.com/decolua/9router)). Repository moved to
  `github.com/some-du6e/10router`, npm package to `10router`, Docker images to
  `some-du6e/10router`, and the app package to `10router-app`.
- **Env**: `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` is now
  `TENROUTER_PROXY_CLIENT_MAX_BODY_SIZE`. The old name is still accepted as a
  fallback, so existing setups keep working.
- **Unchanged on purpose**: the on-disk data directory stays `~/.9router`
  (`%APPDATA%\9router` on Windows) and the Docker volumes stay `9router-data` /
  `9router-usage`, so upgrading installs keep their existing data.

> Entries below this point are historical and refer to the project under its
> former name, 9Router. They are left as-published.

# v0.5.50 (2026-08-05)

## Features
- **Providers**: add TokenRouter (300+ models via OpenAI-compatible gateway) with
  exact per-model pricing for 110 models and `reasoning_effort` thinking config
- **Providers**: add Self-hosted STT / TTS / Embedding — point 9Router at your own
  OpenAI-compatible speech and embedding servers (whisper.cpp, faster-whisper,
  Kokoro-FastAPI, llama-server, vLLM, Infinity). Unlike the named cloud providers
  these read `baseUrl` per connection, so one provider can front several machines
- **Combos**: default-enable vision/audio capacity adapter (auto-routes to a
  vision/audio-capable model when the target lacks that capability, falling back
  to `oc/mimo-v2.5-free`), wired into chat handler routing
- **Endpoint**: auto-provision a "Default Key" for first-time users so `/v1`
  works without a manual dashboard step
- **Codex**: support GPT-5.6 Max/Ultra reasoning-level overrides (cx/ routes only)
- **Qoder**: support PAT (Personal Access Token) connections end-to-end, alongside
  OAuth device flow
- **CLI tools**: add OpenDesign (manalkaff/opendesign) support
- **Headroom**: report effective payload savings (tool schema/history bytes broken
  out, byte-savings % reflects actual outbound reduction)
- **Ollama**: Cloud quota tracker (session + weekly) + proactive background OAuth
  token refresh scheduler for all providers

## Fixes
- **Providers**: remove Qwen (OAuth flow stopped working reliably)
- **Passthrough**: detect codex-tui/Codex Desktop as native Codex client — they
  were falling through to the translator and losing fields like `reasoning.summary`
- **OAuth**: scope antigravity header fixes to loadCodeAssist/onboardUser only
- **OAuth**: keep `open` external in the build so xAI/Grok token refresh works on
  Windows
- **OAuth**: declare missing `searchParams` in register-session handler (was a
  500 instead of JSON on error)
- **DB**: `ENABLE_REQUEST_LOGS` env var now overrides the UI setting correctly;
  observability defaults to off (opt-in)
- **Translator**: preserve Codex Responses Lite tool use across chat-native
  OpenAI-compatible providers
- **Translator**: don't drop image-only user messages in `prepareClaudeRequest`
- **Translator**: drop JSON Schema keywords Gemini rejects (`uniqueItems`,
  `contains`, `multipleOf`, `unevaluatedProperties`, `unevaluatedItems`,
  `contentSchema`)
- **Claude**: remove global header cache that leaked one client's identity
  headers onto another client/account sharing the server; gate `anthropic-beta`
  by model instead
- **Antigravity**: drop retired Gemini 3.0 quota tiers, show Gemini 3.6 Flash
  usage bars
- **Cloudflare AI**: declare API key authentication (dashboard showed "No
  connections" despite an active key)
- **GitHub Copilot**: hold monthly-exhausted accounts until UTC month reset
  instead of only cooling down 120s
- **CodeBuddy**: dodge Tencent CN content filter, add usage tracking, normalize
  codebuddy-intl messages
- **Usage**: stop losing cached prompt tokens in the forced-SSE→JSON path
- **Grok CLI**: display the public subscription tier from the OAuth token claim
- **Providers**: count apikey connections for Ollama free-tier card; free-tier/
  apikey providers without `authModes` now default to apikey (were treated
  oauth-only)
- **Build**: include static/public assets in standalone output (login page hung
  on 404s when run via PM2)
- **Server**: support IntelliJ IDEA OpenAI-compatible clients over HTTP (h2c
  upgrade handling)
- **Auth**: redirect already-logged-in sessions away from `/login`
- **CLI tools**: enable Apply button for dynamic OpenAI/Anthropic-compatible
  provider connections
- **CLI**: include complete API artifacts in the CLI package
- **TTS**: a bare self-hosted model name is the MODEL, not the voice — `kokoro`
  was parsed as a voice against a default model, 404ing or synthesising with the
  wrong one
- **Embeddings**: self-hosted embeddings no longer fall back to `api.openai.com`
  when a connection has no `baseUrl` — that silently sent the input text and API
  key to OpenAI under a provider named "Self-hosted"
- **Embeddings**: an adapter that rejects a misconfigured connection now returns
  400 with the reason instead of escaping the handler uncaught
- **Embeddings**: bound the upstream fetch with `FETCH_CONNECT_TIMEOUT_MS` — an
  endpoint that drops packets never returns headers, so the request previously
  hung indefinitely

## Docs
- **i18n**: fix port typo, add RTK Token Saver feature descriptions

# v0.5.45 (2026-07-30)

## Features
- **TTS**: add Xiaomi MiMo text-to-speech (preset voices 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean, style control, language hint dropdown with Auto-detect, i18n for Style label/placeholder)
- **Providers**: add Poolside (OpenAI-compatible)
- **Providers**: add api-airforce, baidu, bazaarlink, bluesminds, kilo-gateway, llm7, morph, sambanova, tencent
- **OAuth**: zed / trae / windsurf providers + harden callback proxies
- **CLI tools**: set Claude Code max context tokens
- **Qoder**: PAT auth + refresh model list
- **Gemini**: Gemini 3.6 Flash tier routing + Gemini 3.5 Flash Lite
- **Claude**: bump default Opus to `claude-opus-5`
- **Kiro**: add Claude Opus 5 models
- **Usage**: Kimi and DeepSeek usage handlers
- **Usage**: SuperGrok weekly pool via gRPC-web

## Fixes
- **Refresh**: rotate `refresh_token` between retry attempts
- **Kiro**: canonicalize tool history and route API keys correctly
- **Kiro**: normalize dashboard thinking intensity models
- **Cursor**: stop leaking agent tool errors as text
- **Gemini**: fill empty tool schemas after `$ref` strip
- **Antigravity**: strip `stream_options` from non-stream requests
- **Jina-reader**: recover after transient errors, use JSON POST API
- **Usage**: record exact embedding tokens
- **Tunnel**: preserve successor cloudflared PID
- **Console-log**: initialize capture at server boot + prevent SSE proxy buffering
- **Dashboard**: count dual-auth, free-tier OAuth and API-key connections correctly
- **Dashboard**: flex quota rows, thin global scrollbars, no hidden-row overflow

## Docs
- **i18n**: expand pt-BR translation to 986 terms
- README: Indonesian translation

# v0.5.40 (2026-07-20)

## Features
- **i18n**: add Khmer (km) translations
- **CLI tools**: configure Grok Build subagent models
- **Kimi**: merge OAuth into dual-auth provider, add K3 / K2.7 models
- **Dashboard**: ProviderTopology flow animation

## Fixes
- **DB**: resolve better-sqlite3 parameter binding crash
- **Translator**: pass `service_tier` through OpenAI → Responses conversion
- **Kiro**: map GPT-5.6 reasoning effort fields
- **Kiro**: validate terminal streams before emitting output
- **Kiro**: map GPT reasoning effort fields
- **Codex**: current `client_version` + refresh-aware model sync
- **Alicode-intl**: split into Coding Plan + Model Studio providers
- **Cursor**: HTTP/2 AgentService support + version bump 3.12.17
- **Dashboard**: cut duplicate API/icon spam, lazy-load provider assets


# v0.5.35 (2026-07-16)

## Features
- **xAI**: Grok Imagine video generation (`/v1/videos`) + CLI
- **CLI tools**: Grok Build setup — choose separate main/general-purpose/explore/plan models and preserve each model's context window
- **GitHub Copilot**: route Claude models through Copilot's native `/v1/messages`
- **Kiro**: add GPT-5.6 model family (#2596)
- **RTK**: `X-9Router-Token-Saver` header to bypass token savers per request
- **Providers**: quota visibility settings
- **Translator**: drop temperature for all Claude models
- **i18n**: Thai (th) + Persian (fa) translations / README

## Fixes
- **Providers**: bulk-add API keys no longer overwrite existing keys (gap-fill `Key N`)
- **Anthropic**: lowercase `anthropic-version` header to prevent duplication on `/v1/messages`
- **Alicode-intl**: use DashScope compatible-mode endpoint so standard keys work
- **Grok CLI**: align Grok Build with current subscription protocol (#2590)
- **Grok CLI**: surface `expiresAt` so proactive token refresh fires (#2546)
- **Kiro**: improve direct session cache reuse
- **Models**: populate capabilities for live-catalog LLM models
- **Models**: list compatible provider models in `/v1/models`
- **Thinking**: send explicit `thinking:{type:adaptive}` alongside `output_config.effort`
- **Translator**: strip `client_metadata` when converting openai-responses → openai

## Improvements
- **Perf**: skip inactive background services on startup

## Docs
- README: Persian YouTube tutorial

# v0.5.30 (2026-07-10)

## Features
- **Perplexity**: add Agent API provider (#2492)
- **Grok CLI**: add Grok CLI / Grok Build provider with OAuth device-code flow (#2502)
- **Featherless**: add OpenAI-compatible provider presets
- **SearXNG**: configure endpoint via SEARXNG_URL env (#2499)
- **Providers**: add max thinking level for gpt-5.6-sol (#2500)
- **Headroom**: add extras detection and install UI (#2403)
- **Headroom**: activate/uninstall extras + fix interpreter detection
- **PXPipe**: PXPIPE token saver — multimodal prompt compression (#2465)
- **Proxy-Pools**: auto-rotate strategy for no-auth providers (#2409)

## Fixes
- **Cloudflare-AI**: support accountId in bulk key import (#2449)
- **DB**: backup on schema change, MCP child cleanup, codex models, usage providers OOM
- **Codex**: avoid bare-email OAuth dedup (#2477)
- **CLI**: allow staged app bundle builds (#2479)
- **Headroom**: compress Kiro conversation state (#2488)
- **Gemini-CLI**: raise output floor for thinking and add validated toolConfig (#2486)
- **GitHub**: label Copilot profiles by account identity (#2498)
- **OpenAI-to-Claude**: unwrap bare {function:{…}} tools without parent type (#2473)
- **Translator**: clamp thinking effort max->xhigh for OpenAI format (#2466)
- **RTK/find**: detect and group Windows backslash-style find output (#2448)
- **Codex**: handle fast tier and capacity SSE (#2452)
- **Volcengine-ark**: clamp Kimi max_tokens to 32768 endpoint cap
- **Antigravity**: align provider fingerprint with IDE Desktop 2.1.1 (#2389)
- **Pricing**: update Claude/Codex model rates and add new models

## Improvements
- **i18n(zh-CN)**: complete Chinese translations for all UI strings (#2436)
- **API**: caching for tunnel and version status endpoints
- **Perf**: faster dev startup and lighter bundle

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

## Features
- **Usage**: track cached tokens + correct input/output/cache cost (#2209) — hodtien
- **Codex**: show reset credit expiry details (#2290) — Rafli Ahmad Zulfikar
- **NVIDIA**: add new models and capabilities — decolua
- **ClinePass**: add provider support — sternelee

## Fixes
- **Usage**: dedupe streaming request-details log entries — Qin Li
- **Claude**: drop foreign thinking signatures in passthrough — decolua
- Prevent non-SSE stream pipe crash and cross-IdP account overwrites (#2244) — KunN-21
- **Kiro**: route IdC auth to regional CodeWhisperer surface (#2297) — Volodymyr Saakian
- **Kiro**: add Claude Sonnet 5 model support (#2264) — Edison42
- **Xiaomi-tokenplan**: region selector, key validation, multi-connection (#2251) — MiQieR
- **Translator**: strict Anthropic content block compliance (#2225) — Sahrul Ramadhan Hardiansyah
- **Kimchi**: strip reasoning_content echo to bound multi-turn input tokens — KunN-21
- **Kimchi**: bump User-Agent to kimchi/0.1.40 (#2256) — Ansh7473
- **Codebuddy-cn**: strip empty tool_calls arrays to preserve reasoning — zmf
- **Antigravity**: preserve Claude tool delta index (#2223) — Sutarto Jordan Chrisfivo
- **MITM**: generate root CA on server startup (#2228) — Sutarto Jordan Chrisfivo

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns — decolua
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai) — decolua
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM — decolua

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL
