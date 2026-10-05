import {
  type AiGatewayEnvironment,
  proxiedAiGatewayMetadata,
} from "@cubby/shared/ai-gateway-metadata";
import { z } from "zod";
import {
  type ModelSwap,
  modelSwapSchema,
  swapResponsesModel,
} from "./responses-model-swap";

/**
 * The purchase agent's model peer for a live coordinator eval. The agent pins
 * `openai/gpt-6-sol`; this Worker forwards its Responses calls to Cubby's AI
 * Gateway with the candidate model and reasoning effort swapped in, and
 * totals the usage each streamed response reports. Its metadata keeps the
 * agent's feature and operation under the launcher's `ci` or `development`
 * environment, so a paid eval is never attributed to production.
 */
type Env = {
  GATEWAY_OPENAI_URL: string;
  AI_GATEWAY_API_KEY: string;
  GATEWAY_ENVIRONMENT: AiGatewayEnvironment;
};

const responseUsage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  input_tokens_details: z
    .object({ cached_tokens: z.number() })
    .partial()
    .optional(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number() })
    .partial()
    .optional(),
});
const completedEvent = z.object({
  type: z.literal("response.completed"),
  response: z.object({ usage: responseUsage }),
});

const emptyUsage = () => ({
  requests: 0,
  failedRequests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  modelMs: 0,
});

let candidate: ModelSwap | undefined;
let usage = emptyUsage();

function tally(event: z.infer<typeof completedEvent>) {
  const reported = event.response.usage;
  usage.inputTokens += reported.input_tokens;
  usage.cachedInputTokens += reported.input_tokens_details?.cached_tokens ?? 0;
  usage.outputTokens += reported.output_tokens;
  usage.reasoningTokens +=
    reported.output_tokens_details?.reasoning_tokens ?? 0;
}

/** Read the SSE copy of a response for its final usage event. */
async function tallyStream(
  stream: ReadableStream<Uint8Array>,
  started: number,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const parsed = completedEvent.safeParse(
        JSON.parse(line.slice("data: ".length)),
      );
      if (parsed.success) tally(parsed.data);
    }
  }
  usage.modelMs += Date.now() - started;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/configure") {
      candidate = modelSwapSchema.parse(await request.json());
      usage = emptyUsage();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/usage") return Response.json(usage);
    if (!candidate)
      return new Response("No candidate configured", { status: 409 });

    // The agent's provider addresses `https://ai-gateway.invalid/openai/<endpoint>`.
    const endpoint = url.pathname.replace(/^\/openai\//u, "");
    const body = swapResponsesModel(await request.json(), candidate);
    const headers = new Headers(request.headers);
    for (const name of ["authorization", "x-api-key", "content-length"])
      headers.delete(name);
    headers.set("content-type", "application/json");
    headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_API_KEY}`);
    headers.set(
      "cf-aig-metadata",
      JSON.stringify(
        proxiedAiGatewayMetadata(
          request.headers.get("cf-aig-metadata"),
          env.GATEWAY_ENVIRONMENT,
          { feature: "purchase_import_agent", operation: "agent.eval" },
        ),
      ),
    );
    const started = Date.now();
    const upstream = await fetch(
      `${env.GATEWAY_OPENAI_URL}/${endpoint}${url.search}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    usage.requests += 1;
    if (!upstream.ok || !upstream.body) {
      usage.failedRequests += 1;
      return upstream;
    }
    const [forAgent, forTally] = upstream.body.tee();
    ctx.waitUntil(tallyStream(forTally, started));
    return new Response(forAgent, upstream);
  },
};
