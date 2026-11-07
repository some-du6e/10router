/**
 * Does the client want one JSON reply whatever the provider? `stream: false`,
 * or no `stream` with an Accept that takes JSON but not SSE (the Anthropic and
 * OpenAI SDKs send `Accept: application/json` on a non-streaming call and leave
 * `stream` out). When true, chatCore's clientReceivesStream is false for every provider.
 */
export function clientDemandsJson(body, headers = null) {
  if (body.stream === false) return true;
  if (body.stream === true) return false;
  const accept = headers?.accept || "";
  return accept.includes("application/json") && !accept.includes("text/event-stream");
}
