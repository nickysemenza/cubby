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
import { isModelPricingRead } from "./model-pricing-transport";
import { modelSwapSchema, swapResponsesModel } from "../responses-model-swap";

/**
 * The live-evaluation model peer. The purchase agent and web Worker address
 * provider routes at a placeholder host; this Worker forwards requests to
 * Cubby's AI Gateway under the launcher's environment and caller's labels.
 * Workers AI uses the account `/ai/run` route (see `workersAiRunRequest`).
 * Optional `RESPONSES_MODEL`/`RESPONSES_EFFORT` overrides affect only OpenAI
 * Responses calls. `/usage` reports counts, wire models and failed statuses,
 * never request or response content.
 */
type Env = {
  ACCOUNT_ID: string;
  GATEWAY_TOKEN: string;
  GATEWAY_ENVIRONMENT: AiGatewayEnvironment;
  PRICING_CATALOG?: string;
  RESPONSES_MODEL?: string;
  RESPONSES_EFFORT?: string;
  /**
   * "1" forwards a ChatGPT plan attempt to the paid OpenAI route, so a replay
   * measures the requested OpenAI model instead of falling down the funding
   * ladder. Anthropic has no Unified Billing route on this gateway (only the
   * `subscriber-credit` key), so Claude attempts stay on credit.
   */
  PLAN_AS_PAID?: string;
  /** Opt-in replay guard: catalog-derived full-window reservations, never rates. */
  EVAL_BUDGET_USD?: string;
  EVAL_QUOTES?: string;
};

type RouteUsage = {
  requests: number;
  failed: number;
  failedStatuses: number[];
  /** Requests per wire model named in a JSON body. */
  models: Record<string, number>;
};
let usage: Record<string, RouteUsage> = {};
let reservedUsd = 0;
let budgetStopped = false;
const quoteSchema = z.array(
  z.object({
    model: z.string(),
    route: z.enum(["openai", "anthropic", "workers-ai"]),
    maxCostUsd: z.number().finite().nonnegative(),
  }),
);
const decisionBody = z.object({ questions: z.record(z.string(), z.unknown()) });

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
const PROXY_CALL = { feature: "live-evaluation", operation: "proxy" };

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
  headers.delete("x-cubby-inference-funding");
  // The placeholder host must not follow the request to the gateway.
  headers.delete("host");
  headers.set("cf-aig-authorization", `Bearer ${env.GATEWAY_TOKEN}`);
  headers.set("cf-aig-skip-cache", "true");
  // workerd failed to gunzip the gateway's Anthropic event stream ("Gzip
  // decompression failed"), so every streamed Claude answer broke mid-read.
  headers.set("accept-encoding", "identity");
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
    if (isModelPricingRead(request))
      return env.PRICING_CATALOG
        ? new Response(env.PRICING_CATALOG, {
            headers: { "content-type": "application/json" },
          })
        : fetch(request);
    if (url.pathname === "/usage") return Response.json(usage);
    if (url.pathname === "/budget")
      return Response.json({ reservedUsd, stopped: budgetStopped, usage });
    if (url.pathname === "/reset") {
      if (env.EVAL_BUDGET_USD)
        return new Response("A guarded replay budget cannot reset", {
          status: 409,
        });
      usage = {};
      reservedUsd = 0;
      budgetStopped = false;
      return new Response(null, { status: 204 });
    }
    // This Worker has only a Unified Billing token, never a ChatGPT session.
    // Preserve the funding ladder by letting its owner choose the paid stage.
    if (
      request.headers.get("x-cubby-inference-funding") === "subscription" &&
      env.PLAN_AS_PAID !== "1"
    )
      return Response.json(
        {
          error: {
            code: "subscription_unavailable",
            message:
              "ChatGPT subscription is unavailable in the live gateway peer",
          },
        },
        { status: 429 },
      );
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
    if (env.EVAL_BUDGET_USD) {
      const limit = Number(env.EVAL_BUDGET_USD);
      const quotes = quoteSchema.safeParse(
        JSON.parse(env.EVAL_QUOTES ?? "null"),
      );
      const frontier = route === "openai" || route === "anthropic";
      const routeModel =
        route === "workers-ai"
          ? workersAiModel(url.pathname.slice("/workers-ai/".length))
          : model;
      const quote = quotes.success
        ? quotes.data.find(
            (entry) => entry.route === route && entry.model === routeModel,
          )
        : undefined;
      const questions =
        route === "workers-ai" && body
          ? decisionBody.safeParse(JSON.parse(new TextDecoder().decode(body)))
          : null;
      const count = questions?.success
        ? Object.keys(questions.data.questions).length
        : 1;
      const cost = quote ? quote.maxCostUsd * count : NaN;
      // Reserve synchronously before fetch: overlapping calls cannot spend the
      // same capacity. Failed/unknown transmissions keep their full reservation.
      if (
        budgetStopped ||
        env.PLAN_AS_PAID === "1" ||
        request.headers.get("x-cubby-inference-funding") === "paid" ||
        (frontier &&
          (request.headers.get("cf-aig-byok-alias") !== "subscriber-credit" ||
            request.headers.get("cf-aig-no-wholesale") !== "true")) ||
        !Number.isFinite(limit) ||
        limit <= 0 ||
        !Number.isFinite(cost) ||
        count < 1 ||
        (route === "workers-ai" && !questions?.success) ||
        reservedUsd + cost > limit
      ) {
        budgetStopped = true;
        return Response.json(
          {
            error: {
              code: "evaluation_budget_stopped",
              message: "Credit-only replay reservation refused",
            },
          },
          { status: 403 },
        );
      }
      reservedUsd += cost;
    }
    const metadata = proxiedAiGatewayMetadata(
      request.headers.get("cf-aig-metadata"),
      env.GATEWAY_ENVIRONMENT,
      PROXY_CALL,
    );
    const entry = (usage[route] ??= {
      requests: 0,
      failed: 0,
      failedStatuses: [],
      models: {},
    });
    entry.requests += 1;
    const countedModel =
      route === "workers-ai"
        ? workersAiModel(url.pathname.slice("/workers-ai/".length))
        : model;
    if (countedModel)
      entry.models[countedModel] = (entry.models[countedModel] ?? 0) + 1;
    let upstream: Response;
    try {
      upstream = await forward(request, url, route, body, metadata, env);
    } catch (error) {
      entry.failed += 1;
      if (env.EVAL_BUDGET_USD) budgetStopped = true;
      throw error;
    }
    if (!upstream.ok) {
      entry.failed += 1;
      entry.failedStatuses.push(upstream.status);
      if (env.EVAL_BUDGET_USD) budgetStopped = true;
    }
    return upstream;
  },
};
