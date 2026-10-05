import { z } from "zod";
import { modelSwapSchema, swapResponsesModel } from "../responses-model-swap";

/**
 * The coupled harness's model peer for live Tester Army journeys. The purchase
 * agent (as `cubby-test-model`) and the web Worker's structured features (as
 * `cubby-test-gateway`) both address their provider routes at a placeholder
 * host; this Worker forwards each request to the synthetic testing AI Gateway
 * with the Tester Army Unified Billing token. A peer configured with
 * `RESPONSES_MODEL`/`RESPONSES_EFFORT` swaps them into its `/openai/responses`
 * calls; every other request is forwarded unchanged. Nothing is scripted:
 * every model answer is real. `/usage` reports request counts and wire models
 * per route and the HTTP status of each failed call, never content.
 */
type Env = {
  GATEWAY_BASE_URL: string;
  GATEWAY_TOKEN: string;
  RUN_REVISION: string;
  RESPONSES_MODEL?: string;
  RESPONSES_EFFORT?: string;
};

type RouteUsage = {
  requests: number;
  failed: number;
  failedStatuses: number[];
  /** Requests per wire model named in a JSON body. */
  models: Record<string, number>;
};
let usage: Record<string, RouteUsage> = {};

const bodyModel = z.looseObject({ model: z.string() });

/** The model a JSON body names; counting is telemetry, so any other body counts none. */
function wireModel(body: ArrayBuffer) {
  try {
    return bodyModel.safeParse(JSON.parse(new TextDecoder().decode(body))).data
      ?.model;
  } catch {
    return undefined;
  }
}

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
    let body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    if (env.RESPONSES_MODEL && url.pathname === "/openai/responses" && body) {
      const swapped = swapResponsesModel(
        JSON.parse(new TextDecoder().decode(body)),
        modelSwapSchema.parse({
          model: env.RESPONSES_MODEL,
          effort: env.RESPONSES_EFFORT,
        }),
      );
      body = new TextEncoder().encode(JSON.stringify(swapped)).buffer;
    }
    const model = body && wireModel(body);
    const headers = new Headers(request.headers);
    for (const name of DROPPED_HEADERS) headers.delete(name);
    headers.set("cf-aig-authorization", `Bearer ${env.GATEWAY_TOKEN}`);
    headers.set("cf-aig-skip-cache", "true");
    headers.set(
      "cf-aig-metadata",
      JSON.stringify({
        purpose: "synthetic-e2e",
        journey: "tester-army-coupled",
        revision: env.RUN_REVISION,
      }),
    );
    const upstream = await fetch(
      `${env.GATEWAY_BASE_URL}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers,
        body,
      },
    );
    const entry = (usage[route] ??= {
      requests: 0,
      failed: 0,
      failedStatuses: [],
      models: {},
    });
    entry.requests += 1;
    if (model) entry.models[model] = (entry.models[model] ?? 0) + 1;
    if (!upstream.ok) {
      entry.failed += 1;
      entry.failedStatuses.push(upstream.status);
    }
    return upstream;
  },
};
