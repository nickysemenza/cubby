/**
 * The coupled harness's model peer for live Tester Army journeys. The purchase
 * agent (as `cubby-test-model`) and the web Worker's structured features (as
 * `cubby-test-gateway`) both address their provider routes at a placeholder
 * host; this Worker forwards each request unchanged to the synthetic testing
 * AI Gateway with the Tester Army Unified Billing token. Nothing is scripted:
 * every model answer is real. `/usage` reports request counts per route and
 * the HTTP status of each failed call, never content.
 */
type Env = {
  GATEWAY_BASE_URL: string;
  GATEWAY_TOKEN: string;
  RUN_REVISION: string;
};

type RouteUsage = {
  requests: number;
  failed: number;
  failedStatuses: number[];
};
let usage: Record<string, RouteUsage> = {};

const DROPPED_HEADERS = [
  "authorization",
  "x-api-key",
  "content-length",
  "host",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/usage") return Response.json(usage);
    if (url.pathname === "/reset") {
      usage = {};
      return new Response(null, { status: 204 });
    }
    // `/openai/responses`, `/anthropic/v1/messages`, `/workers-ai/...`
    const route = url.pathname.split("/")[1] ?? "unknown";
    const headers = new Headers(request.headers);
    for (const name of DROPPED_HEADERS) headers.delete(name);
    headers.set("cf-aig-authorization", `Bearer ${env.GATEWAY_TOKEN}`);
    headers.set("cf-aig-skip-cache", "true");
    headers.set(
      "cf-aig-metadata",
      JSON.stringify({
        purpose: "synthetic-e2e",
        journey: "import-agent",
        revision: env.RUN_REVISION,
      }),
    );
    const upstream = await fetch(
      `${env.GATEWAY_BASE_URL}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.arrayBuffer(),
      },
    );
    const entry = (usage[route] ??= {
      requests: 0,
      failed: 0,
      failedStatuses: [],
    });
    entry.requests += 1;
    if (!upstream.ok) {
      entry.failed += 1;
      entry.failedStatuses.push(upstream.status);
    }
    return upstream;
  },
};
