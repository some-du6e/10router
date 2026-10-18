# 10router compared with 9router

## Codex

- 10router serves a native Codex endpoint at `/backend-api/codex`, with Responses, compact Responses, model discovery, and WebSocket transport. Codex talks to it as if it were ChatGPT's own backend.
- The Codex CLI tool card writes the native endpoint config for you.
- Codex opens a "prewarm" WebSocket at session start and blocks the first turn until it completes. 10router answers it locally in about 15ms. Bridging it as a real turn took 2.5s, spent a model call, and tripped Codex's connect timeout.
- Account selection skips accounts whose plan can't run the requested model, so a free ChatGPT account no longer eats a 400 on every turn.
- Session affinity pins a Codex conversation to one account. The upstream prompt cache is per account, and without the pin each turn re-paid about 21k tokens of system prompt and tool schemas.
- The dashboard shows pooled usage across Codex accounts. Routing stops reconnecting to an account once its limits are spent, and unblocks it as soon as the usage resets.

## Translation and routing

- Tools from the ChatGPT app survive translation. The app wraps its 23 tools in a Responses `namespace` container, which the old translator collapsed into one empty tool. Opus then guessed tool names and the app rejected them.
- Model ids with a context-window selector, such as `claude-opus-5[1m]`, route to the right model. Before, they returned 404 and Claude Code fell back to Opus 4.8, which also returned 404.
- Claude Code's built-in web search works when Claude requests go to a non-Claude model. 10router sends the search to your configured search providers.
- 10router repairs Opus 5 assistant prefills and generates Claude tool ids when a client leaves them out.
- When a provider rate-limits, the request can stay open until the limit resets, instead of walking down the fallback chain.
- Routing can prefer the Claude or Codex account whose quota resets soonest.
- When every account fails, the error names each account tried and what its provider returned.
- 10router supports GPT-6, GPT-6 Astra, GPT-6.1 Sol, and current Claude models, with their reasoning and effort settings and long-context pricing.

## Notifications and usage

- 10router alerts you when a provider quota runs out and when it resets. It supports Slack, ntfy, Telegram, generic webhooks, and Apprise. You can edit the Slack message text.
- Subscription value tracking prices each month from a recorded price history. In the first version, upgrading a plan repriced every earlier month at the new price.
- OpenCode Go subscription usage shows up next to the other providers.
- An optional T3 usage hub reports Codex and Claude quota and account data.
- Usage logs render prompts as Markdown. Opening full request details requires the dashboard password.

## Dashboard

- The Providers page groups 104 endpoints under 18 vendors and ranks them by the Artificial Analysis Intelligence Index. The same change fixed three logos that belonged to other companies. AssemblyAI had OpenAI's, Deepgram had Anthropic's, and Hyperbolic had OpenRouter's.
- Each account has a detail page. A header toggle blurs account emails for screenshots.
- A seeded demo mode shows the dashboard without real accounts.
- The sidebar shows the commit the server was built from.

## Security

- A fresh install prints a one-time setup token to the console. 9router fell back to the dashboard password `123456`.
- Search, MCP probing, webhooks, and observability block requests to private addresses. Webhooks go out through pinned DNS.
- The dashboard offers a re-auth action for invalid OAuth tokens and cleans up the dead credentials.
- The IDE MITM traffic interception is gone, along with its startup code.

## Tests

- The suite runs deterministic and live tests separately. A regression gate compares each run against a committed baseline, so known failures don't hide new ones.
