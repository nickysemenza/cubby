import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  type AiGatewayCallMetadata,
  aiGatewayMetadataSchema,
} from "@cubby/shared/ai-gateway-metadata";
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
import type {
  AgentGateway,
  ChatGptInference,
  PurchaseAgentEnvironment,
} from "./environment";

type TestModel = NonNullable<PurchaseAgentEnvironment["testModel"]>;
type JsonBody = Awaited<ReturnType<typeof gatewayQuery>>;
type AgentTransport = Extract<AiUsageTransport, "gateway" | "chatgpt">;

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

/**
 * Every coordinator model call's gateway labels; `run-agent` books the same
 * feature and operation, with the Run, in its usage rows.
 */
const COORDINATOR_CALL = {
  feature: "purchase_import_agent",
  operation: "agent.generation",
} satisfies AiGatewayCallMetadata;

/** Provider fetch through Cubby's binding-authenticated Universal Gateway. */
export function createCubbyGatewayFetch(
  route: GatewayRoute,
  gatewayForRequest: () => AgentGateway,
  subscription?: ChatGptInference,
  /** Called before the request leaves with what will carry it. */
  onTransport?: (transport: AgentTransport) => void,
): typeof fetch {
  return async (input, init) => {
    const headers = strippedHeaders(init);
    const body = withSequentialToolCalls(route, await gatewayQuery(init?.body));
    if (route === "openai" && subscription) {
      const response = await subscription(body, {
        signal: init?.signal ?? undefined,
        onSelected: () => onTransport?.("chatgpt"),
      });
      if (response) return response;
    }
    onTransport?.("gateway");
    const gateway = gatewayForRequest();
    const metadata = aiGatewayMetadataSchema.parse({
      ...COORDINATOR_CALL,
      environment: gateway.environment,
    });
    return gateway.run(
      {
        provider: route,
        endpoint: endpointFor(route, requestUrl(input)),
        headers: Object.fromEntries(headers.entries()),
        query: body,
      },
      {
        gateway: { id: gateway.id, metadata },
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
  testModel: TestModel,
  onTransport?: (transport: AgentTransport) => void,
): typeof fetch {
  return async (input, init) => {
    // The scripted peer stands in for the Gateway.
    onTransport?.("gateway");
    const body = withSequentialToolCalls(route, await gatewayQuery(init?.body));
    // A live test peer forwards these labels under its own environment.
    const headers = new Headers(init?.headers);
    headers.set("cf-aig-metadata", JSON.stringify(COORDINATOR_CALL));
    return testModel.fetch(
      new Request(requestUrl(input), {
        method: init?.method ?? "POST",
        headers,
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
  gateway: () => AgentGateway;
  recorder: ContextRecorder;
  testModel?: TestModel;
  subscription?: ChatGptInference;
  /** Each model request's transport, reported before it leaves. */
  onTransport?: (transport: AgentTransport) => void;
}): Provider[] {
  return cubbyPiProviders((route, onUnbilledResponse) =>
    withContextCapture(
      input.testModel
        ? testModelFetch(route, input.testModel, input.onTransport)
        : createCubbyGatewayFetch(
            route,
            input.gateway,
            input.subscription,
            (transport) => {
              input.onTransport?.(transport);
              if (transport === "chatgpt") onUnbilledResponse?.();
            },
          ),
      { recorder: input.recorder, scope: () => CONTEXT_SCOPE },
    ),
  );
}

/** One agent instance per Durable Object, so one recorder scope suffices. */
export const CONTEXT_SCOPE = "run";
