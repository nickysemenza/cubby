import {
  endpointFor,
  gatewayQuery,
  requestUrl,
  strippedHeaders,
} from "@cubby/shared/ai-gateway-request";
import { cubbyPiProviders, type GatewayRoute } from "@cubby/shared/pi-gateway";
import type { Provider } from "@earendil-works/pi-ai";
import { z } from "zod";

import { type ContextRecorder, withContextCapture } from "./context-breakdown";

const CUBBY_GATEWAY_ID = process.env.AI_GATEWAY_ID || "cubby";

type Gateway = Pick<AiGateway, "run">;
type GatewayHost = { gateway(id: string): Gateway };
export type PurchaseAgentTestModelBinding = Pick<Fetcher, "fetch">;
type JsonBody = Awaited<ReturnType<typeof gatewayQuery>>;

/**
 * pi ends a run on a terminating tool only when every call of that round
 * terminates. A pending browser command batched with a progress report would
 * therefore keep the coordinator running while the browser works, so the
 * coordinator never gets parallel calls: one round, one call.
 */
/** A Messages `tool_choice` object; its other fields pass through. */
const anthropicToolChoice = z.looseObject({ type: z.string() });

export function withSequentialToolCalls(
  route: GatewayRoute,
  body: JsonBody,
): JsonBody {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return body;
  if (route === "anthropic") {
    const choice = anthropicToolChoice.safeParse(body.tool_choice).data ?? {
      type: "auto",
    };
    return {
      ...body,
      tool_choice: { ...choice, disable_parallel_tool_use: true },
    };
  }
  return { ...body, parallel_tool_calls: false };
}

/** Provider fetch through Cubby's binding-authenticated Universal Gateway. */
export function createCubbyGatewayFetch(
  route: GatewayRoute,
  gatewayForRequest: () => Gateway,
  runId: () => string | undefined,
): typeof fetch {
  return async (input, init) => {
    const headers = strippedHeaders(init);
    const base = {
      feature: "purchase_import_agent",
      jobKind: "purchase_import_run",
    };
    const run = runId();
    const metadata = run ? { ...base, runId: run } : base;
    return gatewayForRequest().run(
      {
        provider: route,
        endpoint: endpointFor(route, requestUrl(input)),
        headers: Object.fromEntries(headers.entries()),
        query: withSequentialToolCalls(route, await gatewayQuery(init?.body)),
      },
      {
        gateway: { id: CUBBY_GATEWAY_ID, metadata },
        signal: init?.signal ?? undefined,
      },
    );
  };
}

/**
 * The workerd harness's deterministic model peer. This binding is
 * deliberately absent from the deployed Worker; a test service binding cannot
 * clone the provider's AbortSignal, so the request is rebuilt without it.
 */
function testModelFetch(
  route: GatewayRoute,
  testModel: PurchaseAgentTestModelBinding,
): typeof fetch {
  return async (input, init) => {
    const body = withSequentialToolCalls(route, await gatewayQuery(init?.body));
    return testModel.fetch(
      new Request(requestUrl(input), {
        method: init?.method ?? "POST",
        headers: init?.headers,
        body: JSON.stringify(body),
      }),
    );
  };
}

/**
 * Every coordinator model call rides the Gateway, or the test peer when the
 * harness supplies one, and is measured for the run page's per-call context
 * breakdown (sizes only; see context-breakdown.ts).
 */
export function cubbyAgentProviders(input: {
  ai: () => GatewayHost;
  runId: () => string | undefined;
  recorder: ContextRecorder;
  testModel?: PurchaseAgentTestModelBinding;
}): Provider[] {
  const gateway = () => input.ai().gateway(CUBBY_GATEWAY_ID);
  return cubbyPiProviders((route) =>
    withContextCapture(
      input.testModel
        ? testModelFetch(route, input.testModel)
        : createCubbyGatewayFetch(route, gateway, input.runId),
      { recorder: input.recorder, scope: () => CONTEXT_SCOPE },
    ),
  );
}

/** One agent instance per Durable Object, so one recorder scope suffices. */
export const CONTEXT_SCOPE = "run";
