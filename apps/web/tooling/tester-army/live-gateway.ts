import {
  type AiGatewayEnvironment,
  CUBBY_AI_GATEWAY_ID,
  proxiedAiGatewayMetadata,
} from "@cubby/shared/ai/gateway-metadata";
import {
  gatewayProviderUrl,
  strippedHeaders,
  workersAiModel,
  workersAiRunRequest,
} from "@cubby/shared/ai/gateway-request";
import { z } from "zod";
import { isModelPricingRead } from "../ai/model-pricing-transport";
import { modelSwapSchema, swapResponsesModel } from "../responses-model-swap";

/**
 * The coupled harness's model peer for live Tester Army journeys. The purchase
 * agent (as `cubby-test-model`) and the web Worker's structured features (as
 * `cubby-test-gateway`) both address their provider routes at a placeholder
 * host; this Worker forwards each request to Cubby's AI Gateway with the
 * Tester Army Unified Billing token, labelled with the caller's feature and
 * operation under the launcher's `ci` or `development` environment. Workers AI
 * calls go to the account `/ai/run`, never the gateway's provider route
 * (see `workersAiRunRequest`). A peer configured with
 * `RESPONSES_MODEL`/`RESPONSES_EFFORT` swaps them into its `/openai/responses`
 * calls; every other request is forwarded unchanged. Nothing is scripted:
 * every model answer is real. `/usage` reports request counts and wire models
 * per route and the HTTP status of each failed call, never content.
 */
type Env = {
  ACCOUNT_ID: string;
  GATEWAY_TOKEN: string;
  GATEWAY_ENVIRONMENT: AiGatewayEnvironment;
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

/** Labels a request whose caller sent none (or an unreadable header). */
const PROXY_CALL = { feature: "tester-army", operation: "coupled.proxy" };

function forward(
  request: Request,
  url: URL,
  route: string,
  body: ArrayBuffer | undefined,
  metadata: ReturnType<typeof proxiedAiGatewayMetadata>,
  env: Env,
): Promise<Response> {
  if (route === "workers-ai") {
    let run: ReturnType<typeof workersAiRunRequest>;
    try {
      run = workersAiRunRequest({
        accountId: env.ACCOUNT_ID,
        token: env.GATEWAY_TOKEN,
        model: workersAiModel(url.pathname.slice("/workers-ai/".length)),
        input: JSON.parse(new TextDecoder().decode(body)),
        gateway: { id: CUBBY_AI_GATEWAY_ID, metadata, skipCache: true },
      });
    } catch (error) {
      // The run body carries the input as JSON, so it cannot pass bytes on.
      return Promise.resolve(
        new Response(`Unforwardable Workers AI request: ${String(error)}`, {
          status: 400,
        }),
      );
    }
    return fetch(run.url, run.init);
  }
  const headers = strippedHeaders({ headers: request.headers });
  // The placeholder host must not follow the request to the gateway.
  headers.delete("host");
  headers.set("cf-aig-authorization", `Bearer ${env.GATEWAY_TOKEN}`);
  headers.set("cf-aig-skip-cache", "true");
  headers.set("cf-aig-metadata", JSON.stringify(metadata));
  return fetch(
    gatewayProviderUrl({
      accountId: env.ACCOUNT_ID,
      gatewayId: CUBBY_AI_GATEWAY_ID,
      provider: route,
      endpoint: `${url.pathname.slice(`/${route}/`.length)}${url.search}`,
    }),
    { method: request.method, headers, body },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Pricing reads keep their official origin and never count as inference.
    if (isModelPricingRead(request)) return fetch(request);
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
    const metadata = proxiedAiGatewayMetadata(
      request.headers.get("cf-aig-metadata"),
      env.GATEWAY_ENVIRONMENT,
      PROXY_CALL,
    );
    const upstream = await forward(request, url, route, body, metadata, env);
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
