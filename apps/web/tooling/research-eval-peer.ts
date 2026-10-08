import { purchaseAgentToolInputs } from "@cubby/schemas/purchase-agent-services";
import { z } from "zod";

import agentEvalModel from "./agent-eval-model";
import { modelSwapSchema, swapResponsesModel } from "./responses-model-swap";

const source = z.object({
  url: z.url(),
  title: z.string(),
  description: z.string(),
  html: z.string(),
});
const configuration = modelSwapSchema.extend({
  limits: z.object({
    requests: z.number().int().positive(),
    tokens: z.number().int().positive(),
    outputTokens: z.number().int().min(1).max(4_000),
    maxModelOutputTokens: z.number().int().positive().optional(),
    wallMs: z.number().int().positive().max(480_000).default(480_000),
  }),
  sources: z.array(source).max(10),
});
function readConfiguration(body: unknown, subscriptionRequired: boolean) {
  const value = configuration.parse(body);
  if (subscriptionRequired && !value.limits.maxModelOutputTokens)
    throw new Error(
      "Subscription research evaluation requires a catalog output bound",
    );
  return value;
}
function reservedOutputTokens(
  limits: z.infer<typeof configuration>["limits"],
  requested: number,
  subscriptionRequired: boolean,
) {
  if (!subscriptionRequired) return requested;
  if (!limits.maxModelOutputTokens)
    throw new Error("Missing subscription output bound");
  return limits.maxModelOutputTokens;
}
export type ResearchEvalPeerConfiguration = z.input<typeof configuration>;
const inference = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string().optional() })).optional(),
  input: z
    .union([
      z.string(),
      z.array(
        z.looseObject({
          type: z.string().optional(),
          tools: z
            .array(z.looseObject({ name: z.string().optional() }))
            .optional(),
        }),
      ),
    ])
    .optional(),
  max_output_tokens: z.number().int().positive().optional(),
});
function inferenceTools(body: z.infer<typeof inference>) {
  const inline = Array.isArray(body.input)
    ? body.input
        .filter((item) => item.type === "additional_tools")
        .flatMap((item) => item.tools ?? [])
    : [];
  return [...(body.tools ?? []), ...inline];
}
const focusedTools = new Set(Object.keys(purchaseAgentToolInputs));
let configured: z.infer<typeof configuration> | undefined;
let requests = 0;
let reservedTokens = 0;
let refusedRequests = 0;
let expiresAt = 0;
let largestRequestBytes = 0;
let largestReservation = 0;
let lastRefusedReservation: number | null = null;

type Env = Parameters<typeof agentEvalModel.fetch>[1] & {
  ROLE: "researcher" | "assessor";
};

function usesSubscription(env: Env) {
  return (
    Boolean(env.SUBSCRIPTION_PROVIDER_URL) ||
    env.SUBSCRIPTION_REQUIRED === "true"
  );
}

/**
 * Text-only fixture inference reserves UTF-8 request bytes plus output before
 * transmission. Subscription calls reserve the catalog maximum because their
 * requested output cap is stripped. These are conservative reservations, not
 * reported usage; fixed role/case partitions and deadlines bound the run.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: Parameters<typeof agentEvalModel.fetch>[2],
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/configure") {
      configured = readConfiguration(
        await request.json(),
        usesSubscription(env),
      );
      requests = 0;
      reservedTokens = 0;
      refusedRequests = 0;
      largestRequestBytes = 0;
      largestReservation = 0;
      lastRefusedReservation = null;
      expiresAt = Date.now() + configured.limits.wallMs;
      return agentEvalModel.fetch(
        new Request("https://model.test/configure", {
          method: "POST",
          body: JSON.stringify(modelSwapSchema.parse(configured)),
        }),
        env,
        ctx,
      );
    }
    if (url.pathname === "/usage")
      return agentEvalModel.fetch(request, env, ctx);
    if (url.pathname === "/budget")
      return Response.json({
        requests,
        reservedTokens,
        refusedRequests,
        largestRequestBytes,
        largestReservation,
        lastRefusedReservation,
        wallLimitMs: configured?.limits.wallMs ?? 0,
        remainingWallMs: Math.max(0, expiresAt - Date.now()),
      });
    if (url.pathname === "/research-fixture-config")
      return Response.json({ enabled: configured !== undefined });
    if (!configured)
      return new Response("Eval peer is not configured", { status: 409 });
    if (url.pathname === "/research-search") {
      z.object({ query: z.string().min(1) }).parse(await request.json());
      return Response.json({
        items: configured.sources.map(({ html: _html, ...lead }) => lead),
      });
    }
    if (url.pathname === "/research-page") {
      const { url: pageURL } = z
        .object({ url: z.url() })
        .parse(await request.json());
      const page = configured.sources.find((entry) => entry.url === pageURL);
      return Response.json(
        page
          ? { status: "fetched", url: page.url, html: page.html, durationMs: 1 }
          : {
              status: "blocked",
              reason: "No retained synthetic page at this URL",
              durationMs: 1,
            },
      );
    }
    if (url.pathname !== "/openai/responses")
      return new Response("Only text OpenAI Responses inference is permitted", {
        status: 400,
      });
    const body = inference.parse(await request.json());
    const outputTokens = Math.min(
      body.max_output_tokens ?? configured.limits.outputTokens,
      configured.limits.outputTokens,
    );
    const boundedBody = JSON.stringify(
      swapResponsesModel(
        {
          ...body,
          max_output_tokens: outputTokens,
        },
        configured,
      ),
    );
    const reject = (reason: string) => {
      refusedRequests += 1;
      return new Response(reason, { status: 429 });
    };
    const remainingWallMs = expiresAt - Date.now();
    if (remainingWallMs <= 0)
      return reject(
        "Synthetic research investigation wall allowance exhausted",
      );
    if (
      env.ROLE === "researcher" &&
      inferenceTools(body).some(
        (tool) => !tool.name || !focusedTools.has(tool.name),
      )
    )
      return reject("Researcher requested tools outside its focused surface");
    if (
      /"type"\s*:\s*"(?:input_image|image|input_audio|input_file)"/u.test(
        boundedBody,
      )
    )
      return reject(
        "Multimodal inference has no text-only evaluation allowance",
      );
    const requestBytes = new TextEncoder().encode(boundedBody).byteLength;
    const reservation =
      requestBytes +
      reservedOutputTokens(
        configured.limits,
        outputTokens,
        usesSubscription(env),
      );
    largestRequestBytes = Math.max(largestRequestBytes, requestBytes);
    largestReservation = Math.max(largestReservation, reservation);
    if (
      requests >= configured.limits.requests ||
      reservedTokens + reservation > configured.limits.tokens
    ) {
      lastRefusedReservation = reservation;
      return reject("Synthetic research inference allowance exhausted");
    }
    requests += 1;
    reservedTokens += reservation;
    const headers = new Headers(request.headers);
    headers.set("x-cubby-eval-timeout-ms", String(remainingWallMs));
    return agentEvalModel.fetch(
      new Request(request, {
        method: "POST",
        headers,
        body: boundedBody,
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(remainingWallMs),
        ]),
      }),
      env,
      ctx,
    );
  },
};
