import {
  createProvider,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { z } from "zod";

const CUBBY_GATEWAY_ID = "cubby";
const CUBBY_PROVIDER_ID = "cubby";
const FAST_MODEL = "gpt-5.6-luna";
const GATEWAY_BASE_URL = "https://ai-gateway.invalid/openai";
const STRIPPED_SDK_HEADERS = [
  "authorization",
  "x-api-key",
  "content-length",
] as const;
const gatewayQuerySchema = z.record(z.string(), z.json());

type Gateway = Pick<AiGateway, "run">;
type GatewayHost = Pick<Ai, "gateway">;

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

function endpointFor(url: string) {
  const prefix = `${GATEWAY_BASE_URL}/`;
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

/**
 * Pi's OpenAI adapter still builds an ordinary HTTP request. Resolve only its
 * reserved placeholder URL, remove its dummy provider credential, and send
 * the structured request through Cubby's authenticated Universal Gateway
 * binding so Gateway BYOK, logging, and policy stay identical to the web app.
 */
export function createCubbyGatewayFetch(
  gatewayForRequest: () => Gateway,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of STRIPPED_SDK_HEADERS) headers.delete(name);
    return gatewayForRequest().run(
      {
        provider: "openai",
        endpoint: endpointFor(requestUrl(input)),
        headers: Object.fromEntries(headers.entries()),
        query: await gatewayQuery(init?.body),
      },
      {
        gateway: {
          id: CUBBY_GATEWAY_ID,
          metadata: { jobKind: "purchase_import_run" },
        },
        signal: init?.signal ?? undefined,
      },
    );
  };
}

export function cubbyAiGatewayProvider(
  aiForRequest: () => GatewayHost,
): Provider {
  const source = openaiProvider()
    .getModels()
    .find((model) => model.id === FAST_MODEL);
  if (!source || source.api !== "openai-responses") {
    throw new Error(`Pi does not declare ${FAST_MODEL} as OpenAI Responses`);
  }
  const gatewayFetch = createCubbyGatewayFetch(() =>
    aiForRequest().gateway(CUBBY_GATEWAY_ID),
  );
  const baseApi = openAIResponsesApi();
  const api: ProviderStreams = {
    stream: (model, context, options) =>
      baseApi.stream(model, context, { ...options, fetch: gatewayFetch }),
    streamSimple: (model, context, options) =>
      baseApi.streamSimple(model, context, { ...options, fetch: gatewayFetch }),
  };
  return createProvider({
    id: CUBBY_PROVIDER_ID,
    name: "Cubby AI Gateway",
    auth: {
      apiKey: {
        name: "Cubby AI Gateway binding",
        resolve: async () => ({
          auth: { apiKey: "binding-authenticated" },
          source: "Cloudflare AI Gateway binding",
        }),
      },
    },
    models: [
      {
        ...source,
        provider: CUBBY_PROVIDER_ID,
        baseUrl: GATEWAY_BASE_URL,
      },
    ],
    api,
  });
}
