import {
  type AiGatewayEnvironment,
  CUBBY_AI_GATEWAY_ID,
  proxiedAiGatewayMetadata,
} from "@cubby/shared/ai/gateway-metadata";
import { classifyFundingRefusal } from "@cubby/shared/ai/funding-refusal";
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
  /** Explicitly authorized, budget-guarded OpenAI paid evaluation. */
  ALLOW_PAID?: string;
  /** Synthetic orchestration benchmark; supplied only to the agent peer. */
  READ_FANOUT_NAMES?: string;
  READ_FANOUT_MODE?: string;
  /** Shared host-owned physical-call allowance. */
  EVAL_BUDGET_URL?: string;
};

type RouteUsage = {
  requests: number;
  failed: number;
  failedStatuses: number[];
  /** Requests per wire model named in a JSON body. */
  models: Record<string, number>;
  /** Public schema metadata only; never prompts, arguments or source content. */
  firstToolNames?: string[];
  firstToolSchemaChars?: number;
  maxToolSchemaChars?: number;
  codeOfferedRequests?: number;
};
let usage: Record<string, RouteUsage> = {};
const decisionBody = z.object({ questions: z.record(z.string(), z.unknown()) });
const reservation = z.object({ id: z.string() });

async function reserveEvaluation(
  env: Env,
  request: Request,
  route: string,
  body: ArrayBuffer | undefined,
  model: string | undefined,
) {
  if (!env.EVAL_BUDGET_URL) return undefined;
  const frontier = route === "openai" || route === "anthropic";
  const paid =
    env.ALLOW_PAID === "1" &&
    route === "openai" &&
    request.headers.get("x-cubby-inference-funding") === "paid";
  if (
    !paid &&
    (request.headers.get("x-cubby-inference-funding") === "paid" ||
      (frontier &&
        (request.headers.get("cf-aig-byok-alias") !== "subscriber-credit" ||
          request.headers.get("cf-aig-no-wholesale") !== "true")))
  )
    return Response.json(
      {
        error: {
          code: "evaluation_funding_refused",
          message: "Replay requires credit-only frontier routing",
        },
      },
      { status: 403 },
    );
  const questions =
    route === "workers-ai" && body
      ? decisionBody.safeParse(JSON.parse(new TextDecoder().decode(body)))
      : null;
  if (route === "workers-ai" && !questions?.success)
    return new Response("Unquotable decision input", { status: 403 });
  const response = await fetch(env.EVAL_BUDGET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "reserve",
      model:
        route === "workers-ai"
          ? workersAiModel(
              new URL(request.url).pathname.slice("/workers-ai/".length),
            )
          : model,
      route,
      count: questions?.success
        ? Object.keys(questions.data.questions).length
        : 1,
    }),
  });
  if (!response.ok)
    return Response.json(
      {
        error: {
          code: "evaluation_budget_stopped",
          message: (await response.text()).slice(0, 800),
        },
      },
      { status: response.status },
    );
  return reservation.parse(await response.json());
}

async function reportEvaluationFailure(
  env: Env,
  id: string,
  upstream?: Response,
  route?: string,
) {
  if (!env.EVAL_BUDGET_URL) throw new Error("Missing replay allowance");
  // Unknown failures keep their complete reservation. A fully read credit
  // refusal is only a zero-cost candidate; the host also requires the exact
  // failed receipt with no usage before releasing it.
  let refused = false;
  try {
    if (upstream && (route === "openai" || route === "anthropic"))
      refused =
        classifyFundingRefusal({
          status: upstream.status,
          text: await upstream.clone().text(),
          funding: route === "openai" ? "openai_credit" : "subscriber_credit",
        }) !== null;
  } finally {
    await fetch(env.EVAL_BUDGET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: refused ? "refused" : "failed", id }),
    });
  }
}

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
  if (
    env.ALLOW_PAID === "1" &&
    route === "openai" &&
    request.headers.get("x-cubby-inference-funding") === "paid"
  ) {
    headers.delete("cf-aig-byok-alias");
    headers.delete("cf-aig-no-wholesale");
  }
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
    if (url.pathname === "/reset") {
      if (env.EVAL_BUDGET_URL)
        return new Response("A guarded replay cannot reset", { status: 409 });
      usage = {};
      return new Response(null, { status: 204 });
    }
    // This Worker has only a Unified Billing token, never a ChatGPT session.
    // Preserve the funding ladder by letting its owner choose the paid stage.
    if (request.headers.get("x-cubby-inference-funding") === "subscription")
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
    // Let the funding ladder select its real paid stage, with accurate paid
    // usage attribution, rather than buying a credit/subscription attempt.
    if (
      env.EVAL_BUDGET_URL &&
      env.ALLOW_PAID === "1" &&
      route === "openai" &&
      request.headers.get("x-cubby-inference-funding") !== "paid"
    )
      return Response.json(
        {
          error: {
            code: "insufficient_quota",
            message:
              "Credit routing is disabled for this authorized paid evaluation",
          },
        },
        { status: 429 },
      );
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
    if (env.READ_FANOUT_NAMES && url.pathname === "/openai/responses" && body) {
      const names = z
        .array(z.string().min(1))
        .min(2)
        .max(16)
        .parse(JSON.parse(env.READ_FANOUT_NAMES));
      const parsed = z
        .looseObject({ instructions: z.string().optional() })
        .parse(JSON.parse(new TextDecoder().decode(body)));
      const orchestration =
        env.READ_FANOUT_MODE === "code-bulk"
          ? "First load codemode with tool_search (query codemode, limit 1) if it is not offered. Then use one codemode call containing one tools.mcp__cubby__entity_read resolve query with all eight names. Assign the parsed JSON directly to response; its top-level field is results, with no matches wrapper. Then text({fanoutMatches: response.results.map(row => ({name: row.name, exact: row.exact, candidates: row.candidates.map(candidate => ({id: candidate.id, name: candidate.name}))}))}). Do not print full candidate records. The query inputs above are complete; schema discovery is unnecessary."
          : env.READ_FANOUT_MODE === "code"
            ? "Use exactly one codemode call to run these queries with Promise.all via tools.mcp__cubby__entity_read, and text({fanoutMatches: results}) where results contains one {name,matches} object per query. Each nested tool returns JSON text; parse it. The query inputs above are complete; schema discovery is unnecessary."
            : env.READ_FANOUT_MODE === "bulk"
              ? "Use one ordinary mcp__cubby__entity_read resolve call with all eight names in its names array."
              : "Use eight separate ordinary mcp__cubby__entity_read calls, one name per call.";
      const lookupInstructions =
        env.READ_FANOUT_MODE === "bulk" || env.READ_FANOUT_MODE === "code-bulk"
          ? 'Batch all names into one {action:"resolve",entity:"product",names:[...names]} query.'
          : 'Each query must use {action:"resolve",entity:"product",names:[name]}. Do not combine names into a batched query: this controlled benchmark compares orchestration of independent reads.';
      body = new TextEncoder().encode(
        JSON.stringify({
          ...parsed,
          instructions: `${parsed.instructions ?? ""}\nSynthetic catalog lookup benchmark: after claiming the Email and before writing its outcome, resolve these names: ${JSON.stringify(names)}. ${lookupInstructions} ${orchestration} Do this workload once per Email, not once per turn. Never repeat it after writing an import or settling the source; stop when the claim returns no work. An empty catalog result is valid. Then complete the ordinary Mail import workflow using the Email's evidence.`,
        }),
      ).buffer;
    }
    const model = body && wireModel(body);
    const admission = await reserveEvaluation(env, request, route, body, model);
    if (admission instanceof Response) return admission;
    const metadata = proxiedAiGatewayMetadata(
      request.headers.get("cf-aig-metadata"),
      env.GATEWAY_ENVIRONMENT,
      PROXY_CALL,
    );
    const entry: RouteUsage = (usage[route] ??= {
      requests: 0,
      failed: 0,
      failedStatuses: [],
      models: {},
    });
    if (body && url.pathname === "/openai/responses") {
      try {
        const envelope = z
          .object({
            tools: z.array(z.unknown()).optional(),
            input: z.union([z.string(), z.array(z.unknown())]).optional(),
          })
          .parse(JSON.parse(new TextDecoder().decode(body)));
        const declarations = [...(envelope.tools ?? [])];
        if (Array.isArray(envelope.input))
          for (const item of envelope.input) {
            const batch = z
              .object({
                type: z.enum(["additional_tools", "tool_search_output"]),
                tools: z.array(z.unknown()),
              })
              .safeParse(item);
            if (batch.success) declarations.push(...batch.data.tools);
          }
        const tools = z
          .array(z.looseObject({ name: z.string() }))
          .parse(declarations);
        const names = [...new Set(tools.map((tool) => tool.name))];
        const characters = JSON.stringify(tools).length;
        if (entry.requests === 0) {
          entry.firstToolNames = names;
          entry.firstToolSchemaChars = characters;
        }
        entry.maxToolSchemaChars = Math.max(
          entry.maxToolSchemaChars ?? 0,
          characters,
        );
        entry.codeOfferedRequests =
          (entry.codeOfferedRequests ?? 0) + Number(names.includes("codemode"));
      } catch {
        // SILENT: optional catalog telemetry must not change provider forwarding.
      }
    }
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
      if (admission) await reportEvaluationFailure(env, admission.id);
      throw error;
    }
    if (!upstream.ok) {
      entry.failed += 1;
      entry.failedStatuses.push(upstream.status);
      if (admission)
        await reportEvaluationFailure(env, admission.id, upstream, route);
    }
    if (admission) {
      const headers = new Headers(upstream.headers);
      headers.set("cf-aig-log-id", admission.id);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
    return upstream;
  },
};
