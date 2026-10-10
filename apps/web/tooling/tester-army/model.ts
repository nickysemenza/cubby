import { inspect } from "node:util";
import {
  CF_ACCOUNT_ID,
  CUBBY_AI_GATEWAY_ID,
  testAiGatewayEnvironment,
} from "@cubby/shared/ai/gateway-metadata";
import { DECISION_MODEL, FAST_MODEL } from "@cubby/shared/ai/models";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { decisionExecutor } from "@e2e-dev/decision";
import {
  gatewayBaseURL,
  workersAiRunRequest,
} from "@cubby/shared/ai/gateway-request";
import { localSecret } from "../local-secret";
import { createOpenAI } from "@ai-sdk/openai";
import {
  APICallError,
  experimental_decide as decide,
  generateText,
  tool,
} from "ai";
import { z } from "zod";

/** A workflow forwards an unset repository variable as "": treat it as omitted. */
const optionalSetting = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

const configuration = z
  .object({
    TESTER_ARMY_CF_API_TOKEN: optionalSetting(z.string().min(1)),
    TESTER_ARMY_CF_ACCOUNT_ID: optionalSetting(
      z
        .string()
        .regex(/^[a-f0-9]{32}$/)
        .default(CF_ACCOUNT_ID),
    ),
    TESTER_ARMY_MODEL: optionalSetting(z.string().min(1).optional()),
  })
  .superRefine((value, context) => {
    if (
      value.TESTER_ARMY_MODEL &&
      !/^openai\/gpt-[a-z0-9.-]+$/u.test(value.TESTER_ARMY_MODEL)
    )
      context.addIssue({
        code: "custom",
        path: ["TESTER_ARMY_MODEL"],
        message: "Gateway models are OpenAI Responses ids like openai/gpt-…",
      });
  })
  .transform((value) => ({
    ...value,
    TESTER_ARMY_MODEL: value.TESTER_ARMY_MODEL ?? `openai/${FAST_MODEL}`,
  }));

export function modelConfiguration(
  env: Record<string, string | undefined> = process.env,
  readSecret: typeof localSecret = localSecret,
) {
  const result = configuration.safeParse({
    ...env,
    TESTER_ARMY_CF_API_TOKEN: readSecret(
      ["TESTER_ARMY_CF_API_TOKEN", "AI_GATEWAY_API_KEY"],
      { envFile: env.TESTER_ARMY_ENV_FILE },
    ),
  });
  if (!result.success)
    throw new Error(
      `Tester Army configuration missing or invalid: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}

/** The driver's gateway scoping: Cubby's gateway, never production-labelled. */
export function testerArmyGatewayHeaders(ci: string | undefined) {
  return {
    "cf-aig-gateway-id": CUBBY_AI_GATEWAY_ID,
    "cf-aig-skip-cache": "true",
    "cf-aig-metadata": JSON.stringify({
      environment: testAiGatewayEnvironment(ci),
      feature: "tester-army",
      operation: "driver",
    }),
  };
}

// The upstream executor allows transport retries; this lane measures one attempt.
async function assertGatewaySuccess(response: Response, url: string) {
  if (!response.ok)
    throw new APICallError({
      message: `Tester Army gateway HTTP ${response.status}: ${await response.text()}`,
      url,
      requestBodyValues: undefined,
      statusCode: response.status,
      isRetryable: false,
    });
}

function failFastGatewayFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new Request(input, init).url;
    let response: Response;
    try {
      response = await fetcher(input, init);
      // These drivers use non-streaming inference. Read the body inside the
      // boundary so provider-utils cannot retry a connection reset after headers.
      if (response.body !== null)
        response = new Response(await response.arrayBuffer(), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new APICallError({
        message: `Tester Army gateway request failed: ${inspect(cause)}`,
        url,
        requestBodyValues: undefined,
        // Provider-utils retries network codes found anywhere in an Error cause chain.
        isRetryable: false,
      });
    }
    await assertGatewaySuccess(response, url);
    return response;
  };
}

export function testerArmyModel(
  config = modelConfiguration(),
  fetcher: typeof fetch = fetch,
) {
  const provider = createOpenAI({
    apiKey: config.TESTER_ARMY_CF_API_TOKEN,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${config.TESTER_ARMY_CF_ACCOUNT_ID}/ai/v1`,
    headers: testerArmyGatewayHeaders(process.env.CI),
    fetch: failFastGatewayFetch(fetcher),
  });
  // The unified endpoint names models `author/model` (`openai/gpt-…`).
  return provider.responses(config.TESTER_ARMY_MODEL);
}

/** Jev's decision SDK uses TypeSafe wire JSON; Cloudflare owns billing/auth. */
export function testerArmyDecisionModel(
  config = modelConfiguration(),
  fetcher: typeof fetch = fetch,
) {
  if (!config.TESTER_ARMY_CF_API_TOKEN)
    throw new Error("Jev requires TESTER_ARMY_CF_API_TOKEN");
  const token = config.TESTER_ARMY_CF_API_TOKEN;
  return createTypeSafeAi({
    apiKey: token,
    baseURL: gatewayBaseURL("workers-ai"),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const { model: _model, ...query } = z
        .record(z.string(), z.json())
        .parse(await request.json());
      const gatewayRequest = workersAiRunRequest({
        accountId: config.TESTER_ARMY_CF_ACCOUNT_ID,
        token,
        model: DECISION_MODEL,
        input: query,
        signal: request.signal,
        gateway: {
          id: CUBBY_AI_GATEWAY_ID,
          skipCache: true,
          metadata: {
            environment: testAiGatewayEnvironment(process.env.CI),
            feature: "tester-army",
            operation: "driver",
          },
        },
      });
      const response = await failFastGatewayFetch(fetcher)(
        gatewayRequest.url,
        gatewayRequest.init,
      );
      const body: unknown = await response.json();
      const envelope = z.object({ result: z.unknown() }).safeParse(body);
      const payload = envelope.success ? envelope.data.result : body;
      const run = z
        .object({ state: z.literal("Completed"), result: z.unknown() })
        .safeParse(payload);
      return Response.json(run.success ? run.data.result : payload, {
        status: response.status,
      });
    },
  }).decisionModel(DECISION_MODEL);
}

export function testerArmyDriverIdentity(config = modelConfiguration()) {
  return `${DECISION_MODEL} + ${config.TESTER_ARMY_MODEL}`;
}

/** Replay selects the same driver/text tier; credentials stay in the environment. */
export function testerArmyReplayCommand(
  command: string[],
  config = modelConfiguration(),
) {
  return ["env", `TESTER_ARMY_MODEL=${config.TESTER_ARMY_MODEL}`, ...command];
}

export function testerArmyAgent(config = modelConfiguration()) {
  const model = testerArmyModel(config);
  return {
    model,
    executor: decisionExecutor({
      model: testerArmyDecisionModel(config),
      textModel: model,
    }),
    providerOptions: testerArmyProviderOptions,
  };
}

export const testerArmyProviderOptions = {
  openai: { forceReasoning: true, reasoningEffort: "medium", store: false },
};

export async function preflightTesterArmyModel() {
  const config = modelConfiguration();
  {
    const result = await decide({
      model: testerArmyDecisionModel(config),
      state: "Synthetic preflight: editor changes are ready to save.",
      questions: {
        action: {
          type: "choice",
          instructions: "Choose the next action",
          criteria: { save: "Save changes", cancel: "Discard changes" },
        },
      },
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
    });
    if (result.answers.action.choice !== "save")
      throw new Error("Jev preflight did not select Save");
    console.log(
      `[tester-army] Decision preflight passed (${DECISION_MODEL}); ${result.usage.inputTokens ?? 0} input tokens`,
    );
  }
  const response = await generateText({
    model: testerArmyModel(),
    providerOptions: testerArmyProviderOptions,
    maxRetries: 0,
    maxOutputTokens: 1024,
    abortSignal: AbortSignal.timeout(60_000),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "This is a synthetic testing preflight. Inspect the supplied image and call ready with supported=true.",
          },
          {
            type: "file",
            mediaType: "image/png",
            data: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGNwaDhAEmIY1TCqYfhqAACldYAQpGTU2QAAAABJRU5ErkJggg==",
              "base64",
            ),
          },
        ],
      },
    ],
    tools: {
      ready: tool({
        description: "Confirm image and function-call support",
        inputSchema: z.object({ supported: z.literal(true) }),
      }),
    },
    toolChoice: { type: "tool", toolName: "ready" },
  });
  if (!response.toolCalls.some((call) => call.toolName === "ready"))
    throw new Error(
      "Tester Army model preflight returned no readiness tool call",
    );
  console.log(
    `[tester-army] Model preflight passed (${testerArmyDriverIdentity(config)}); ${response.totalUsage.totalTokens ?? 0} tokens`,
  );
}
