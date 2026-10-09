import type { EvalUsage } from "./ai/eval-support";
import {
  type AiGatewayEnvironment,
  CUBBY_AI_GATEWAY_ID,
  proxiedAiGatewayMetadata,
} from "@cubby/shared/ai/gateway-metadata";
import {
  gatewayProviderUrl,
  strippedHeaders,
} from "@cubby/shared/ai/gateway-request";
import { z } from "zod";
import {
  describeErrorCauses,
  scrubErrorMessage,
} from "../src/lib/error-diagnostics";
import {
  type ModelSwap,
  modelSwapSchema,
  swapResponsesModel,
} from "./responses-model-swap";

/**
 * The purchase agent's model peer for a live coordinator eval. The agent pins
 * `openai/gpt-6-sol`; this Worker forwards its Responses calls to Cubby's AI
 * Gateway or the explicitly required local subscription transport, with
 * candidate model and reasoning effort swapped in, and
 * totals the usage each streamed response reports. Its metadata keeps the
 * agent's feature and operation under the launcher's `ci` or `development`
 * environment, so a paid eval is never attributed to production.
 */
type Env = {
  ACCOUNT_ID: string;
  AI_GATEWAY_API_KEY: string;
  GATEWAY_ENVIRONMENT: AiGatewayEnvironment;
  SUBSCRIPTION_PROVIDER_URL?: string;
  SUBSCRIPTION_REQUIRED?: string;
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

const emptyUsage = (): EvalUsage => ({
  requests: 0,
  failedRequests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  modelMs: 0,
  calls: [],
});

let candidate: ModelSwap | undefined;
let usage = emptyUsage();

function recordFailure(
  record: EvalUsage,
  stage: "http" | "transport" | "stream",
  message: string,
  status?: number,
) {
  const failures = (record.failures ??= []);
  if (failures.length >= 8) return;
  failures.push({
    stage,
    status,
    message: scrubErrorMessage(message).slice(0, 2000),
  });
}

async function refusalBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "Upstream refusal had no body";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } finally {
    void reader.cancel().catch(() => {
      // SILENT: the original refusal body still belongs to the caller.
    });
  }
}

function tally(event: z.infer<typeof completedEvent>, record: EvalUsage) {
  const reported = event.response.usage;
  record.calls.push({
    inputTokens: reported.input_tokens,
    cachedInputTokens: reported.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: reported.output_tokens,
  });
  record.inputTokens += reported.input_tokens;
  record.cachedInputTokens += reported.input_tokens_details?.cached_tokens ?? 0;
  record.outputTokens += reported.output_tokens;
  record.reasoningTokens +=
    reported.output_tokens_details?.reasoning_tokens ?? 0;
}

/** Read the SSE copy of a response for its final usage event. */
async function tallyStream(
  stream: ReadableStream<Uint8Array>,
  started: number,
  record: EvalUsage,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const parsed = completedEvent.safeParse(
          JSON.parse(line.slice("data: ".length)),
        );
        if (parsed.success) {
          tally(parsed.data, record);
          completed = true;
        }
      }
    }
    return completed;
  } finally {
    record.modelMs += Date.now() - started;
  }
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
      usage = {
        ...emptyUsage(),
        transport:
          env.SUBSCRIPTION_PROVIDER_URL || env.SUBSCRIPTION_REQUIRED === "true"
            ? "chatgpt"
            : "gateway",
      };
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/usage") return Response.json(usage);
    if (!candidate)
      return new Response("No candidate configured", { status: 409 });

    // The agent's provider addresses `https://ai-gateway.invalid/openai/<endpoint>`.
    const endpoint = url.pathname.replace(/^\/openai\//u, "");
    const body = swapResponsesModel(await request.json(), candidate);
    const headers = strippedHeaders({ headers: request.headers });
    headers.set("content-type", "application/json");
    if (!env.SUBSCRIPTION_PROVIDER_URL)
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
    let target: string;
    if (env.SUBSCRIPTION_PROVIDER_URL) {
      if (endpoint !== "responses")
        throw new Error("Subscription eval supports Responses only");
      const origin = new URL(env.SUBSCRIPTION_PROVIDER_URL);
      if (
        origin.protocol !== "http:" ||
        origin.hostname !== "127.0.0.1" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw new Error("Subscription evaluation requires a loopback origin");
      target = new URL("/responses", origin).href;
    } else {
      if (env.SUBSCRIPTION_REQUIRED === "true")
        throw new Error("Required subscription eval transport is unavailable");
      target = gatewayProviderUrl({
        accountId: env.ACCOUNT_ID,
        gatewayId: CUBBY_AI_GATEWAY_ID,
        provider: "openai",
        endpoint: `${endpoint}${url.search}`,
      });
    }
    const started = Date.now();
    usage.requests += 1;
    usage.failedRequests += 1;
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      recordFailure(
        usage,
        "transport",
        describeErrorCauses(error)
          .causes.map((cause) => cause.message)
          .join("\n"),
      );
      throw error;
    }
    usage.failedRequests -= 1;
    if (!upstream.ok || !upstream.body) {
      usage.failedRequests += 1;
      recordFailure(
        usage,
        "http",
        await refusalBody(upstream.clone()),
        upstream.status,
      );
      return upstream;
    }
    const [forAgent, forTally] = upstream.body.tee();
    const record = usage;
    ctx.waitUntil(
      tallyStream(forTally, started, record).then(
        (completed) => {
          if (!completed) {
            record.failedRequests += 1;
            recordFailure(
              record,
              "stream",
              "Stream ended without response.completed",
            );
          }
        },
        (error) => {
          record.failedRequests += 1;
          recordFailure(
            record,
            "stream",
            describeErrorCauses(error)
              .causes.map((cause) => cause.message)
              .join("\n"),
          );
        },
      ),
    );
    return new Response(forAgent, upstream);
  },
};
