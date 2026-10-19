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
  SubscriptionRequiredError,
  type GatewayResponseInfo,
  requestUrl,
  runUniversalGateway,
  type InferenceFunding,
} from "@cubby/shared/ai/gateway-request";
import {
  type ChatGatewayProvider,
  type SupportedChatModel,
  getChatModelConfig,
  QUALITY_MODEL,
} from "@cubby/shared/ai/models";
import {
  cubbyPiProviders,
  fundedCubbyPiProviders,
  type GatewayFetchFor,
} from "@cubby/shared/ai/pi-providers";
import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import { z } from "zod";

import { type ContextRecorder, withContextCapture } from "./context-breakdown";
import type { AgentGateway, PurchaseAgentEnvironment } from "./environment";

type TestModel = NonNullable<PurchaseAgentEnvironment["testModel"]>;
type FundingRefusal = (message: AssistantMessage) => Promise<void>;
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

const CLAIM_TOOL = "claim_next_import_work";
// Anthropic allows at most four cache breakpoints per request; pi-ai already
// marks the system prompt, the last tool and the latest user message.
const ANTHROPIC_MAX_BREAKPOINTS = 4;

const wireBlock = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  cache_control: z.unknown().optional(),
});
const wireMessage = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(wireBlock)]),
});
const anthropicBody = z.looseObject({ messages: z.array(wireMessage) });

const breakpoints = (value: unknown): number =>
  Array.isArray(value)
    ? value.reduce((sum: number, item) => sum + breakpoints(item), 0)
    : typeof value === "object" && value !== null
      ? (Object.hasOwn(value, "cache_control") ? 1 : 0) +
        Object.values(value).reduce(
          (sum: number, item) => sum + breakpoints(item),
          0,
        )
      : 0;

/**
 * Cache hints for a coordinator request. Work-item trimming replaces
 * everything after the latest claim each Email, so the conversation
 * breakpoint pi-ai places on the latest user message never matches the next
 * Email: mark the end of the kept prefix (kickoff, member and system
 * messages) so it is read from cache instead of re-written. OpenAI requests
 * key their prompt cache to the Run.
 */
export function withWorkItemCaching(
  route: ChatGatewayProvider,
  body: GatewayQuery,
  cacheKey: string | undefined,
): GatewayQuery {
  if (route !== "anthropic")
    return cacheKey && body.prompt_cache_key === undefined
      ? { ...body, prompt_cache_key: cacheKey }
      : body;
  const parsed = anthropicBody.safeParse(body);
  if (!parsed.success || breakpoints(body) >= ANTHROPIC_MAX_BREAKPOINTS)
    return body;
  const { messages } = parsed.data;
  let claim = -1;
  messages.forEach((message, index) => {
    if (
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => block.type === "tool_use" && block.name === CLAIM_TOOL,
      )
    )
      claim = index;
  });
  const end = messages[claim - 1];
  if (claim < 1 || !end || breakpoints(end) > 0) return body;
  const cacheControl =
    JSON.stringify(body).match(/"cache_control":(\{[^}]*\})/)?.[1] ??
    '{"type":"ephemeral"}';
  const blocks =
    typeof end.content === "string"
      ? [{ type: "text", text: end.content }]
      : end.content;
  const last = blocks.at(-1);
  if (!last) return body;
  const marked = {
    ...end,
    content: [
      ...blocks.slice(0, -1),
      { ...last, cache_control: JSON.parse(cacheControl) },
    ],
  };
  return {
    ...body,
    messages: z
      .array(z.json())
      .parse(
        messages.map((message, index) =>
          index === claim - 1 ? marked : message,
        ),
      ),
  };
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
  | "subscriptionRequired"
  | "subscriptionFallback"
  | "beforePaidRequest"
  | "beforeFreeRequest"
> {
  funding?: InferenceFunding;
  fundingFallback?: boolean;
  fixedModel?: PurchaseAgentEnvironment["fixedModel"];
  onFundingRefusal?: FundingRefusal;
  /** Pi may open before dispatch binds a Run; resolve its policy per request. */
  transportPolicy?: () => Pick<
    GatewayFetchRoutes,
    | "subscriptionRequired"
    | "subscriptionFallback"
    | "beforePaidRequest"
    | "beforeFreeRequest"
  >;
  gateway: () => AgentGateway;
  testModel?: TestModel;
  subscription?: ChatGptInference;
  /** Host admission can reject locally before any provider route transmits. */
  beforeTransmission?: () => Response | undefined;
  /** Prompt-cache key for OpenAI requests: one per Run. */
  cacheKey?: () => string | undefined;
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
  const routedFetch = (
    policy: Pick<
      GatewayFetchRoutes,
      | "subscriptionRequired"
      | "subscriptionFallback"
      | "beforePaidRequest"
      | "beforeFreeRequest"
    >,
  ) =>
    gatewayFetchThrough({
      provider: route,
      funding: options.funding,
      rewriteQuery: (body) =>
        withWorkItemCaching(
          route,
          withSequentialToolCalls(route, body),
          options.cacheKey?.(),
        ),
      chatGpt: options.subscription,
      ...policy,
      onTransport: options.onTransport,
      onResponse: options.onResponse,
      testPeer: () =>
        testModel &&
        (async (request) => {
          // A live test peer forwards these labels under its own environment.
          const headers = new Headers(request.headers);
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
        const controls = {
          id: gateway.id,
          skipCache: true,
          collectPayload: false,
          metadata: aiGatewayMetadataSchema.parse({
            ...COORDINATOR_CALL,
            environment: gateway.environment,
          }),
        };
        return gateway.coordinatedFetch
          ? gateway.coordinatedFetch(route, request, controls)
          : runUniversalGateway(gateway, route, request, controls);
      },
    });
  return async (input, init) => {
    const rejection = options.beforeTransmission?.();
    if (rejection) return rejection;
    const policy = {
      subscriptionRequired: options.subscriptionRequired,
      subscriptionFallback: options.subscriptionFallback,
      beforePaidRequest: options.beforePaidRequest,
      beforeFreeRequest: options.beforeFreeRequest,
      ...options.transportPolicy?.(),
    };
    const admit = policy.beforePaidRequest;
    const admitFree = policy.beforeFreeRequest;
    let refusal: { error: unknown } | undefined;
    try {
      return await routedFetch({
        ...policy,
        beforePaidRequest:
          admit &&
          (async (request) => {
            try {
              await admit(request);
            } catch (error: unknown) {
              refusal = { error };
              throw error;
            }
          }),
        beforeFreeRequest:
          admitFree &&
          (async (request, funding) => {
            try {
              return await admitFree(request, funding);
            } catch (error: unknown) {
              refusal = { error };
              throw error;
            }
          }),
      })(input, init);
    } catch (error: unknown) {
      if (refusal) return admissionRefusal(refusal.error);
      if (init?.signal?.aborted) throw error;
      if (error instanceof SubscriptionRequiredError)
        return admissionRefusal(error);
      return transportFailure(error);
    }
  };
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * A fetch that throws reaches the coordinator as the provider SDK's bare
 * "Connection error.", hiding the cause from the transcript. Paid admission
 * (household AI budget, Run no longer executable) and a disconnected required
 * plan refuse with a final 403;
 * any other failure is a 502, which pi still retries and the funding ladder
 * never mistakes for a funding refusal.
 */
function admissionRefusal(error: unknown): Response {
  return Response.json(
    {
      error: { type: "cubby_admission_refused", message: errorMessage(error) },
    },
    { status: 403 },
  );
}

function transportFailure(error: unknown): Response {
  return Response.json(
    {
      error: { type: "cubby_transport_failed", message: errorMessage(error) },
    },
    { status: 502 },
  );
}

/**
 * Every coordinator model call rides the Gateway, or the test peer when the
 * harness supplies one, and is measured for the run page's per-call context
 * breakdown (sizes only; see context-breakdown.ts).
 */
export function cubbyAgentProviders(
  input: AgentFetchOptions & { recorder: ContextRecorder },
): Provider[] {
  // The coordinator's configured model (its manifest primary, or the
  // escalation model for an escalated Email) answers first.
  const providers =
    input.fundingFallback && !input.fixedModel
      ? (fetchFor: GatewayFetchFor, onRefused?: FundingRefusal) =>
          fundedCubbyPiProviders(fetchFor, onRefused, {
            paid: true,
            leadWithRequested: true,
          })
      : cubbyPiProviders;
  return providers((route, onUnbilledResponse, funding) => {
    let finalTransport: AgentTransport | undefined;
    const routedFetch = createCubbyGatewayFetch(route, {
      ...input,
      funding,
      onTransport: (transport) => {
        finalTransport = transport;
        input.onTransport?.(transport);
      },
    });
    return withContextCapture(
      async (request, init) => {
        finalTransport = undefined;
        const response = await routedFetch(request, init);
        // Selection can precede quota fallback. Only the final successful
        // plan response is unbilled; HTTP refusals can trigger SDK retries.
        if (response.ok && finalTransport === "chatgpt") onUnbilledResponse?.();
        return response;
      },
      { recorder: input.recorder, scope: () => CONTEXT_SCOPE },
    );
  }, input.onFundingRefusal);
}

/** Fixed peers rewrite Responses bodies, so protocol selection must happen first. */
export function cubbyAgentModel(
  pinned: SupportedChatModel,
  fixedModel?: PurchaseAgentEnvironment["fixedModel"],
) {
  const modelId = fixedModel ? QUALITY_MODEL : pinned;
  return { provider: getChatModelConfig(modelId).gatewayProvider, modelId };
}

/** One agent instance per Durable Object, so one recorder scope suffices. */
export const CONTEXT_SCOPE = "run";
