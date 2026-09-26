const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const SLACK_PATH = /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers:{"cache-control":"no-store"}
  });
}

function validWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SLACK_HOSTS.has(url.hostname) && SLACK_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/slack-test") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json({error:"Method not allowed."}, 405);

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 64_000) return json({error:"Request is too large."}, 413);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({error:"Invalid request body."}, 400);
    }

    if (!validWebhook(body.webhook)) {
      return json({error:"Enter a valid Slack incoming webhook URL."}, 400);
    }
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return json({error:"Missing Slack message payload."}, 400);
    }

    try {
      const slackResponse = await fetch(body.webhook, {
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify(body.payload)
      });
      const slackMessage = await slackResponse.text();
      if (!slackResponse.ok) {
        return json({error:`Slack returned ${slackResponse.status}: ${slackMessage.slice(0, 160)}`}, 502);
      }
      return json({ok:true});
    } catch (error) {
      const detail = error instanceof Error ? error.message.replaceAll(body.webhook, "Slack webhook") : "Unknown network error";
      return json({error:`Could not reach the Slack webhook: ${detail}`}, 502);
    }
  }
};
