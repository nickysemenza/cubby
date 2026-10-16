import type { AiCostEvidence } from "./pricing";
import {
  createProvider,
  type Api,
  type Model,
  type Provider,
  type ProviderStreams,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AssistantMessageEvent,
  type StreamOptions,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { z } from "zod";

import {
  gatewayBaseURL,
  gatewayResponseInfo,
  isInferenceFundingRefusal,
  isInferenceStreamFundingRefusal,
  type InferenceFunding,
} from "./gateway-request";
import {
  anthropicChatModelSchema,
  type ChatGatewayProvider,
  openAiChatModelSchema,
  getChatModelConfig,
  type SupportedChatModel,
} from "./models";

/**
 * Cubby's chat models as pi-ai providers, one per AI Gateway route. Both the
 * web Worker and the purchase agent build their `Models` from this, so a
 * model id, its limits, and its price are declared once. The transport is the
 * caller's: the agent passes its AI-binding `gateway.run` shim, the web Worker
 * its `gatewayFetch`. Every request therefore rides the Gateway; the base URLs
 * are the unroutable placeholders only those shims resolve.
 */
export type GatewayFetchFor = (
  provider: ChatGatewayProvider,
  /** Marks the call unbilled: a ChatGPT plan response pi-ai must not price. */
  onUnbilledResponse?: () => void,
  funding?: InferenceFunding,
) => typeof fetch;

/** Providers SDKs refuse to run without some key; the shims strip it. */
function gatewayAuth(route: ChatGatewayProvider) {
  return {
    apiKey: {
      name: `Cubby ${route} Gateway transport`,
      resolve: async () => ({
        auth: { apiKey: "cf-aig-gateway" },
        source: "Cloudflare AI Gateway",
      }),
    },
  };
}

const comparisonCosts = new WeakMap<object, number>();
const comparisonEvidence = new WeakMap<object, AiCostEvidence["standard"]>();

function throughFetch(
  streams: ProviderStreams,
  fetchForCall: (onUnbilledResponse: () => void) => typeof fetch,
): ProviderStreams {
  const run = (
    start: (fetchFn: typeof fetch) => AssistantMessageEventStream,
    model: Model<Api>,
  ) => {
    const capturedAt = new Date().toISOString();
    let unbilled = false;
    const markUnbilled = () => {
      unbilled = true;
    };
    const fetchFn = fetchForCall(markUnbilled);
    // A gateway cache HIT replays a stored answer the gateway does not bill;
    // its tokens stay as evidence and its transport stays `gateway`.
    const source = start(async (input, init) => {
      const response = await fetchFn(input, init);
      if (gatewayResponseInfo(response).gatewayCacheStatus === "hit")
        markUnbilled();
      return response;
    });
    const output = createAssistantMessageEventStream();
    const normalize = (message: AssistantMessage) => {
      const prompt =
        message.usage.input +
        message.usage.cacheRead +
        message.usage.cacheWrite;
      const rates =
        (model.cost.tiers ?? [])
          .filter((tier) => prompt > tier.inputTokensAbove)
          .reduce<NonNullable<Model<Api>["cost"]["tiers"]>[number] | undefined>(
            (widest, tier) =>
              widest && widest.inputTokensAbove >= tier.inputTokensAbove
                ? widest
                : tier,
            undefined,
          ) ?? model.cost;
      comparisonEvidence.set(message, {
        source: "estimate",
        pricingSource: "pi_sdk",
        pricingSnapshot: {
          provider: model.provider,
          model: model.id,
          capturedAt,
          rates: {
            input: rates.input,
            output: rates.output,
            cache_read: rates.cacheRead,
            cache_write: rates.cacheWrite,
          },
        },
      });
      if (unbilled) {
        if (message.usage.cost.total !== 0 || !comparisonCosts.has(message))
          comparisonCosts.set(message, message.usage.cost.total);
        message.usage.cost = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        };
      }
    };
    // pi-ai's event stream resolves generation failures as terminal error
    // events; its iterator and result promise do not reject.
    void (async () => {
      for await (const event of source) {
        const message =
          event.type === "done"
            ? event.message
            : event.type === "error"
              ? event.error
              : event.partial;
        normalize(message);
        output.push(event);
      }
      const result = await source.result();
      normalize(result);
      output.end(result);
    })();
    return output;
  };
  return {
    stream: (model, context, options) =>
      run(
        (fetch) => streams.stream(model, context, { ...options, fetch }),
        model,
      ),
    streamSimple: (model, context, options) =>
      run(
        (fetch) => streams.streamSimple(model, context, { ...options, fetch }),
        model,
      ),
  };
}

const PDF_DATA_URL = "data:application/pdf;base64,";

const responsesContentPart = z.looseObject({
  type: z.string(),
  image_url: z.string().optional(),
});
const responsesContent = z.union([z.string(), z.array(responsesContentPart)]);
/** The part of a Responses request this rewrite touches; the rest passes through. */
const responsesRequest = z.looseObject({
  input: z.array(
    z.looseObject({
      content: responsesContent.optional(),
      output: responsesContent.optional(),
    }),
  ),
});
type ResponsesContentPart = z.infer<typeof responsesContentPart>;

/**
 * pi-ai's only binary content type is an image, so a PDF (a receipt) leaves
 * it as an `input_image` carrying a PDF data URL, which the Responses API
 * rejects. A PDF must be an `input_file`.
 */
function pdfAsInputFile(part: ResponsesContentPart) {
  return part.type === "input_image" && part.image_url?.startsWith(PDF_DATA_URL)
    ? {
        type: "input_file",
        filename: "evidence.pdf",
        file_data: part.image_url,
      }
    : part;
}

function normalizePdfParts(
  content: z.infer<typeof responsesContent> | undefined,
) {
  return Array.isArray(content) ? content.map(pdfAsInputFile) : content;
}

function withPdfInputFiles(fetchFn: typeof fetch): typeof fetch {
  return (input, init) => {
    const body = init?.body;
    if (!body || !String(body).includes(PDF_DATA_URL))
      return fetchFn(input, init);
    const request = responsesRequest.parse(JSON.parse(String(body)));
    return fetchFn(input, {
      ...init,
      body: JSON.stringify({
        ...request,
        input: request.input.map((item) => ({
          ...item,
          content: normalizePdfParts(item.content),
          output: normalizePdfParts(item.output),
        })),
      }),
    });
  };
}

const pdfJson = z.json();
type PdfJson = z.infer<typeof pdfJson>;

/** PDFs occur both in user content and nested MCP tool results. */
function anthropicDocumentParts(value: PdfJson): PdfJson {
  if (Array.isArray(value)) return value.map(anthropicDocumentParts);
  if (value === null || typeof value !== "object") return value;
  const source = value.source;
  const pdf =
    value.type === "image" &&
    source !== null &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    source.media_type === "application/pdf";
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "type" && pdf ? "document" : anthropicDocumentParts(entry),
    ]),
  );
}

function withAnthropicPdfDocuments(fetchFn: typeof fetch): typeof fetch {
  return (input, init) => {
    if (
      typeof init?.body !== "string" ||
      !init.body.includes("application/pdf")
    )
      return fetchFn(input, init);
    return fetchFn(input, {
      ...init,
      body: JSON.stringify(
        anthropicDocumentParts(pdfJson.parse(JSON.parse(init.body))),
      ),
    });
  };
}

function catalogModels<TApi extends Api>(
  provider: Provider<TApi>,
  ids: readonly string[],
  baseUrl: string,
): Model<TApi>[] {
  return ids.map((id) => {
    const model = provider.getModels().find((candidate) => candidate.id === id);
    if (!model) throw new Error(`pi-ai does not declare ${id}`);
    return { ...model, baseUrl };
  });
}

export function cubbyPiProviders(fetchFor: GatewayFetchFor): Provider[] {
  return [
    createProvider({
      id: "openai",
      name: "OpenAI through Cubby AI Gateway",
      auth: gatewayAuth("openai"),
      models: catalogModels(
        openaiProvider(),
        openAiChatModelSchema.options,
        gatewayBaseURL("openai"),
      ),
      api: throughFetch(openAIResponsesApi(), (onUnbilledResponse) =>
        withPdfInputFiles(fetchFor("openai", onUnbilledResponse)),
      ),
    }),
    createProvider({
      id: "anthropic",
      name: "Anthropic through Cubby AI Gateway",
      auth: gatewayAuth("anthropic"),
      models: catalogModels(
        anthropicProvider(),
        anthropicChatModelSchema.options,
        gatewayBaseURL("anthropic"),
      ),
      api: throughFetch(anthropicMessagesApi(), (onUnbilledResponse) =>
        withAnthropicPdfDocuments(fetchFor("anthropic", onUnbilledResponse)),
      ),
    }),
  ];
}

/**
 * Funding retries restart one generation from its input transcript. Hold every
 * event until that attempt settles, so a refused partial tool call never runs.
 * Completed prior turns and their writes remain in pi's durable transcript.
 */
export function fundedCubbyPiProviders(
  fetchFor: GatewayFetchFor,
  onRefusedAttempt?: (message: AssistantMessage) => Promise<void>,
): Provider[] {
  const base = cubbyPiProviders(fetchFor);
  return base.map((provider): Provider => {
    const run = (
      model: Model<Api>,
      context: Parameters<Provider["streamSimple"]>[1],
      options: StreamOptions | undefined,
      simple: boolean,
    ) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        const fast = model.id.includes("haiku") || model.id === "gpt-6-luna";
        const primary: SupportedChatModel = fast
          ? "claude-haiku-4-5"
          : "claude-opus-5-5";
        const subscription: SupportedChatModel = fast
          ? "gpt-6-luna"
          : "gpt-6-sol";
        const attempts: {
          model: SupportedChatModel;
          funding: InferenceFunding;
        }[] = [
          { model: primary, funding: "subscriber_credit" },
          { model: subscription, funding: "subscription" },
          { model: primary, funding: "paid" },
        ];
        for (const attempt of attempts) {
          let refused = false;
          const providers = cubbyPiProviders((route, unbilled) => {
            const fetch = fetchFor(route, unbilled, attempt.funding);
            return async (input, init) => {
              const response = await fetch(input, init);
              if (!response.ok)
                refused = isInferenceFundingRefusal(
                  response.status,
                  await response.clone().text(),
                  attempt.funding,
                );
              if (response.ok && attempt.funding === "subscriber_credit")
                unbilled?.();
              return response;
            };
          });
          const route = getChatModelConfig(attempt.model).gatewayProvider;
          const selected = providers.find(
            (candidate) => candidate.id === route,
          );
          const target = selected
            ?.getModels()
            .find((candidate) => candidate.id === attempt.model);
          if (!selected || !target)
            throw new Error(`Missing funded model ${attempt.model}`);
          const stream = simple
            ? selected.streamSimple(target, context, {
                ...options,
                maxRetries: 0,
              })
            : selected.stream(target, context, {
                ...fundingOptions(options, route),
                maxRetries: 0,
              });
          const events: AssistantMessageEvent[] = [];
          for await (const event of stream) events.push(event);
          const result = await stream.result();
          const failed = result.stopReason === "error";
          // pi exposes a late SSE quota refusal on its terminal error message.
          const quota =
            refused ||
            isInferenceStreamFundingRefusal(
              result.errorMessage ?? "",
              attempt.funding,
            );
          if (attempt.funding === "subscriber_credit")
            creditMessages.add(result);
          if (
            failed &&
            quota &&
            !options?.signal?.aborted &&
            attempt.funding !== "paid"
          ) {
            await onRefusedAttempt?.(result);
            continue;
          }
          for (const event of events) output.push(event);
          output.end(result);
          return;
        }
      })().catch((error: unknown) => {
        // Dispatch errors occur before a provider's own terminal event exists.
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        output.push({ type: "error", reason: "error", error: message });
        output.end(message);
      });
      return output;
    };
    return {
      ...provider,
      stream: (model, context, options) => run(model, context, options, false),
      streamSimple: (model, context, options) =>
        run(model, context, options, true),
    };
  });
}

const creditMessages = new WeakSet<object>();

/** Keep forced tool selection while translating the two provider vocabularies. */
function fundingOptions(
  options: StreamOptions | undefined,
  route: ChatGatewayProvider,
): ProviderStreamOptions {
  const parsed = z
    .looseObject({
      toolChoice: z
        .union([z.string(), z.looseObject({ name: z.string() })])
        .optional(),
      reasoningEffort: z.string().optional(),
      effort: z.string().optional(),
    })
    .parse(options ?? {});
  const { toolChoice, reasoningEffort, effort, ...common } = parsed;
  const name = typeof toolChoice === "object" ? toolChoice.name : undefined;
  return route === "anthropic"
    ? {
        ...common,
        ...(name ? { toolChoice: { type: "tool", name } } : {}),
        effort: effort ?? reasoningEffort,
      }
    : {
        ...common,
        ...(name ? { toolChoice: { type: "function", name } } : {}),
        reasoningEffort: reasoningEffort ?? effort,
      };
}

/** pi initializes zero counters before a provider responds. Preserve an
 * upstream failure without usage as unknown; a failed validation with
 * reported tokens remains billable. */
export function piTokenUsage(message: {
  stopReason: AssistantMessage["stopReason"];
  usage: Pick<
    AssistantMessage["usage"],
    "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"
  > &
    Partial<Pick<AssistantMessage["usage"], "cost">>;
}) {
  const unknown =
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    message.usage.totalTokens === 0;
  return {
    costEvidence: message.usage.cost
      ? {
          standard: unknown
            ? null
            : (comparisonEvidence.get(message) ?? {
                source: "estimate" as const,
                pricingSource: "pi_sdk" as const,
              }),
          charged: unknown
            ? null
            : (comparisonEvidence.get(message) ?? {
                source: "estimate" as const,
                pricingSource: "pi_sdk" as const,
              }),
          billingReason: creditMessages.has(message)
            ? ("subscriber_credit" as const)
            : ("standard" as const),
        }
      : null,
    standardCost: unknown
      ? null
      : (comparisonCosts.get(message) ?? message.usage.cost?.total ?? null),
    chargedCost: unknown ? null : (message.usage.cost?.total ?? null),
    inputTokens: unknown ? null : message.usage.input,
    outputTokens: unknown ? null : message.usage.output,
    cacheReadTokens: unknown ? null : message.usage.cacheRead,
    cacheWriteTokens: unknown ? null : message.usage.cacheWrite,
  };
}
