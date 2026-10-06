import {
  CF_ACCOUNT_ID,
  CUBBY_AI_GATEWAY_ID,
  testAiGatewayEnvironment,
} from "@cubby/shared/ai/gateway-metadata";
import { FAST_MODEL, QUALITY_MODEL } from "@cubby/shared/ai/models";
import { chatgpt } from "e2e/oauth/chatgpt";
import { localSecret } from "../local-secret";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

/** A workflow forwards an unset repository variable as "": treat it as omitted. */
const optionalSetting = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

/**
 * How the driver reaches its model. `chatgpt` (the default) uses the member's
 * ChatGPT subscription from `e2e login openai` (`~/.config/e2e/oauth.json`,
 * or `E2E_OAUTH_CREDENTIALS` in CI) and needs no Cloudflare token; `gateway`
 * keeps the Cloudflare AI Gateway route with Unified Billing.
 */
export const testerArmyProvider = optionalSetting(
  z.enum(["chatgpt", "gateway"]).default("chatgpt"),
);

const configuration = z
  .object({
    TESTER_ARMY_PROVIDER: testerArmyProvider,
    TESTER_ARMY_CF_API_TOKEN: optionalSetting(z.string().min(1).optional()),
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
      value.TESTER_ARMY_PROVIDER === "gateway" &&
      !value.TESTER_ARMY_CF_API_TOKEN
    )
      context.addIssue({
        code: "custom",
        path: ["TESTER_ARMY_CF_API_TOKEN"],
        message: "The gateway provider needs a Cloudflare inference token",
      });
    if (
      value.TESTER_ARMY_PROVIDER === "gateway" &&
      value.TESTER_ARMY_MODEL &&
      !/^openai\/gpt-[a-z0-9.-]+$/u.test(value.TESTER_ARMY_MODEL)
    )
      context.addIssue({
        code: "custom",
        path: ["TESTER_ARMY_MODEL"],
        message: "Gateway models are OpenAI Responses ids like openai/gpt-…",
      });
  })
  .transform((value) => {
    const id = value.TESTER_ARMY_MODEL?.replace(/^(openai|chatgpt)\//u, "");
    return {
      ...value,
      /** `provider/model`, as reports and summaries show it. */
      TESTER_ARMY_MODEL:
        value.TESTER_ARMY_PROVIDER === "chatgpt"
          ? `chatgpt/${id ?? QUALITY_MODEL}`
          : `openai/${id ?? FAST_MODEL}`,
    };
  });

export function modelConfiguration(
  env: NodeJS.ProcessEnv = process.env,
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

export function testerArmyModel() {
  const config = modelConfiguration();
  const modelId = config.TESTER_ARMY_MODEL.slice(
    config.TESTER_ARMY_MODEL.indexOf("/") + 1,
  );
  if (config.TESTER_ARMY_PROVIDER === "chatgpt") return chatgpt(modelId);
  const provider = createOpenAI({
    apiKey: config.TESTER_ARMY_CF_API_TOKEN,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${config.TESTER_ARMY_CF_ACCOUNT_ID}/ai/v1`,
    headers: testerArmyGatewayHeaders(process.env.CI),
  });
  return provider.responses(modelId);
}

export const testerArmyProviderOptions = {
  openai: { forceReasoning: true, reasoningEffort: "medium", store: false },
};

export async function preflightTesterArmyModel() {
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
    `[tester-army] Model preflight passed (${modelConfiguration().TESTER_ARMY_MODEL}); ${response.totalUsage.totalTokens ?? 0} tokens`,
  );
}
