import {
  createProvider,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { z } from "zod";

const CUBBY_GATEWAY_ID = "cubby";
const OPENAI_MODELS = ["gpt-6-sol"] as const;
const ANTHROPIC_MODELS = ["claude-haiku-4-5", "claude-sonnet-5"] as const;
const STRIPPED_SDK_HEADERS = [
  "authorization",
  "x-api-key",
  "content-length",
] as const;
const gatewayQuerySchema = z.record(z.string(), z.json());

type GatewayProvider = "openai" | "anthropic";
type Gateway = Pick<AiGateway, "run">;
type GatewayHost = { gateway(id: string): Gateway };
export type PurchaseAgentTestModelBinding = Pick<Fetcher, "fetch">;

function gatewayBaseUrl(provider: GatewayProvider) {
  return `https://ai-gateway.invalid/${provider}`;
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

function endpointFor(provider: GatewayProvider, url: string) {
  const prefix = `${gatewayBaseUrl(provider)}/`;
  if (url.startsWith(prefix)) return url.slice(prefix.length);
  const parsed = new URL(url);
  return `${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`;
}

async function gatewayQuery(body: BodyInit | null | undefined) {
  const decoded = await new Response(body ?? "{}")
    .json<unknown>()
    .catch(() => undefined);
  const parsed = gatewayQuerySchema.safeParse(decoded);
  return parsed.success ? parsed.data : {};
}

/** Provider SDK fetch shim for Cubby's binding-authenticated Universal Gateway. */
export function createCubbyGatewayFetch(
  provider: GatewayProvider,
  gatewayForRequest: () => Gateway,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of STRIPPED_SDK_HEADERS) headers.delete(name);
    return gatewayForRequest().run(
      {
        provider,
        endpoint: endpointFor(provider, requestUrl(input)),
        headers: Object.fromEntries(headers.entries()),
        query: await gatewayQuery(init?.body),
      },
      {
        gateway: {
          id: CUBBY_GATEWAY_ID,
          metadata: {
            feature: "purchase_import_agent",
            jobKind: "purchase_import_run",
          },
        },
        signal: init?.signal ?? undefined,
      },
    );
  };
}

function streamsThroughGateway(
  streams: ProviderStreams,
  gatewayFetch: typeof fetch,
): ProviderStreams {
  return {
    stream: (model, context, options) =>
      streams.stream(model, context, { ...options, fetch: gatewayFetch }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, {
        ...options,
        fetch: gatewayFetch,
      }),
  };
}

function bindingAuth(provider: string) {
  return {
    apiKey: {
      name: `Cubby ${provider} Gateway binding`,
      resolve: async () => ({
        auth: { apiKey: "binding-authenticated" },
        source: "Cloudflare AI Gateway binding",
      }),
    },
  };
}

function selectedModels<const TIds extends readonly string[]>(
  provider: Provider,
  ids: TIds,
  baseUrl: string,
) {
  return ids.map((id) => {
    const model =
      provider.getModels().find((candidate) => candidate.id === id) ??
      (id === "gpt-6-sol"
        ? (() => {
            const template = provider
              .getModels()
              .find((candidate) => candidate.id === "gpt-5.5-pro");
            if (!template) throw new Error("Pi does not declare gpt-5.5-pro");
            // Pi's catalog has not caught up to GPT-6. Responses uses this
            // id verbatim; inherit the 1.05m context and 128k output limits.
            return {
              ...template,
              id,
              name: "GPT-6 Sol",
              cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
            };
          })()
        : undefined);
    if (!model) throw new Error(`Pi does not declare ${id}`);
    return { ...model, baseUrl };
  });
}

/** All coordinator and optional escalation models, forced through Gateway. */
export function cubbyAiGatewayProviders(
  aiForRequest: () => GatewayHost,
  testModel?: PurchaseAgentTestModelBinding,
): Provider[] {
  const gateway = () => aiForRequest().gateway(CUBBY_GATEWAY_ID);
  // This binding is intentionally absent from the deployed worker. Workerd
  // harnesses can supply a deterministic Responses peer here, while every
  // normal request still goes through the binding-authenticated Gateway.
  const testFetch: typeof fetch | undefined = testModel
    ? (input, init) => {
        // Flue passes an AbortSignal to provider fetch. Unlike the production
        // Gateway binding, a test service binding cannot clone it.
        const source = input instanceof Request ? input : undefined;
        return testModel.fetch(
          new Request(requestUrl(input), {
            method: init?.method ?? source?.method,
            headers: init?.headers ?? source?.headers,
            body:
              init?.body ??
              (source?.method === "GET" || source?.method === "HEAD"
                ? undefined
                : source?.body),
          }),
        );
      }
    : undefined;
  const openaiFetch = testFetch ?? createCubbyGatewayFetch("openai", gateway);
  const anthropicFetch =
    testFetch ?? createCubbyGatewayFetch("anthropic", gateway);
  return [
    createProvider({
      id: "openai",
      name: "OpenAI through Cubby AI Gateway",
      auth: bindingAuth("OpenAI"),
      models: selectedModels(
        openaiProvider(),
        OPENAI_MODELS,
        gatewayBaseUrl("openai"),
      ),
      api: streamsThroughGateway(openAIResponsesApi(), openaiFetch),
    }),
    createProvider({
      id: "anthropic",
      name: "Anthropic through Cubby AI Gateway",
      auth: bindingAuth("Anthropic"),
      models: selectedModels(
        anthropicProvider(),
        ANTHROPIC_MODELS,
        gatewayBaseUrl("anthropic"),
      ),
      api: streamsThroughGateway(anthropicMessagesApi(), anthropicFetch),
    }),
  ];
}
