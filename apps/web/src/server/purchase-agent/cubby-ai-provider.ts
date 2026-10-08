import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  type AiGatewayCallMetadata,
  aiGatewayMetadataSchema,
} from "@cubby/shared/ai/gateway-metadata";
import {
  type ChatGptInference,
  type GatewayQuery,
  type GatewayFetchRoutes,
  gatewayFetchThrough,
  type GatewayResponseInfo,
  requestUrl,
  runUniversalGateway,
} from "@cubby/shared/ai/gateway-request";
import type { ChatGatewayProvider } from "@cubby/shared/ai/models";
import { cubbyPiProviders } from "@cubby/shared/ai/pi-providers";
import type { Provider } from "@earendil-works/pi-ai";
import { z } from "zod";

import { type ContextRecorder, withContextCapture } from "./context-breakdown";
import type { AgentGateway, PurchaseAgentEnvironment } from "./environment";

type TestModel = NonNullable<PurchaseAgentEnvironment["testModel"]>;
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
  route: ChatGatewayProvider,
  body: GatewayQuery,
): GatewayQuery {
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

interface AgentFetchOptions extends Pick<
  GatewayFetchRoutes,
  "subscriptionRequired" | "beforePaidRequest"
> {
  gateway: () => AgentGateway;
  testModel?: TestModel;
  subscription?: ChatGptInference;
  /** Each model request's transport, reported before it leaves. */
  onTransport?: (transport: AgentTransport) => void;
  /** Each received model response's gateway log id and cache verdict. */
  onResponse?: (info: GatewayResponseInfo) => void;
}

/**
 * Provider fetch through Cubby's binding-authenticated Universal Gateway, or
 * the workerd harness's deterministic model peer when it supplies one. That
 * peer binding is deliberately absent from the deployed Worker; a test
 * service binding cannot clone the provider's AbortSignal, so its request is
 * rebuilt without it.
 */
export function createCubbyGatewayFetch(
  route: ChatGatewayProvider,
  options: AgentFetchOptions,
): typeof fetch {
  const { testModel } = options;
  return gatewayFetchThrough({
    provider: route,
    rewriteQuery: (body) => withSequentialToolCalls(route, body),
    chatGpt: options.subscription,
    subscriptionRequired: options.subscriptionRequired,
    beforePaidRequest: options.beforePaidRequest,
    onTransport: options.onTransport,
    onResponse: options.onResponse,
    testPeer: () =>
      testModel &&
      (async (request) => {
        // A live test peer forwards these labels under its own environment.
        const headers = new Headers(request.init?.headers);
        headers.set("cf-aig-metadata", JSON.stringify(COORDINATOR_CALL));
        return testModel.fetch(
          new Request(requestUrl(request.input), {
            method: request.init?.method ?? "POST",
            headers,
            body: JSON.stringify(await request.query()),
          }),
        );
      }),
    gateway: (request) => {
      const gateway = options.gateway();
      return runUniversalGateway(gateway, route, request, {
        id: gateway.id,
        skipCache: true,
        collectPayload: false,
        metadata: aiGatewayMetadataSchema.parse({
          ...COORDINATOR_CALL,
          environment: gateway.environment,
        }),
      });
    },
  });
}

/**
 * Every coordinator model call rides the Gateway, or the test peer when the
 * harness supplies one, and is measured for the run page's per-call context
 * breakdown (sizes only; see context-breakdown.ts).
 */
export function cubbyAgentProviders(
  input: AgentFetchOptions & { recorder: ContextRecorder },
): Provider[] {
  return cubbyPiProviders((route, onUnbilledResponse) =>
    withContextCapture(
      createCubbyGatewayFetch(route, {
        ...input,
        onTransport: (transport) => {
          input.onTransport?.(transport);
          if (transport === "chatgpt") onUnbilledResponse?.();
        },
      }),
      { recorder: input.recorder, scope: () => CONTEXT_SCOPE },
    ),
  );
}

/** One agent instance per Durable Object, so one recorder scope suffices. */
export const CONTEXT_SCOPE = "run";
