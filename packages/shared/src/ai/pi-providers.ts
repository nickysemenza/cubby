import {
  createProvider,
  type Api,
  type Model,
  type Provider,
  type ProviderStreams,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { z } from "zod";

import { gatewayBaseURL, gatewayResponseInfo } from "./gateway-request";
import {
  anthropicChatModelSchema,
  type ChatGatewayProvider,
  openAiChatModelSchema,
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

function throughFetch(
  streams: ProviderStreams,
  fetchForCall: (onUnbilledResponse: () => void) => typeof fetch,
): ProviderStreams {
  const run = (
    start: (fetchFn: typeof fetch) => AssistantMessageEventStream,
  ) => {
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
      if (unbilled)
        message.usage.cost = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        };
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
      run((fetch) => streams.stream(model, context, { ...options, fetch })),
    streamSimple: (model, context, options) =>
      run((fetch) =>
        streams.streamSimple(model, context, { ...options, fetch }),
      ),
  };
}

const PDF_DATA_URL = "data:application/pdf;base64,";

const responsesContentPart = z.looseObject({
  type: z.string(),
  image_url: z.string().optional(),
});
/** The part of a Responses request this rewrite touches; the rest passes through. */
const responsesRequest = z.looseObject({
  input: z.array(
    z.looseObject({
      content: z.union([z.string(), z.array(responsesContentPart)]).optional(),
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
        input: request.input.map((item) =>
          Array.isArray(item.content)
            ? { ...item, content: item.content.map(pdfAsInputFile) }
            : item,
        ),
      }),
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
        fetchFor("anthropic", onUnbilledResponse),
      ),
    }),
  ];
}

/** pi initializes zero counters before a provider responds. Preserve an
 * upstream failure without usage as unknown; a failed validation with
 * reported tokens remains billable. */
export function piTokenUsage(message: {
  stopReason: AssistantMessage["stopReason"];
  usage: Pick<
    AssistantMessage["usage"],
    "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"
  >;
}) {
  const unknown =
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    message.usage.totalTokens === 0;
  return {
    inputTokens: unknown ? null : message.usage.input,
    outputTokens: unknown ? null : message.usage.output,
    cacheReadTokens: unknown ? null : message.usage.cacheRead,
    cacheWriteTokens: unknown ? null : message.usage.cacheWrite,
  };
}
