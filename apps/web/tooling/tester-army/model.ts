import {
  CF_ACCOUNT_ID,
  CUBBY_AI_GATEWAY_ID,
  testAiGatewayEnvironment,
} from "@cubby/shared/ai/gateway-metadata";
import { FAST_MODEL } from "@cubby/shared/ai/models";
import { localSecret } from "../local-secret";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

/** A workflow forwards an unset repository variable as "": treat it as omitted. */
const optionalSetting = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);

/** The driver model when `TESTER_ARMY_MODEL` is omitted. */
export const testerArmyModelSetting = optionalSetting(
  z
    .string()
    .regex(/^openai\/gpt-[a-z0-9.-]+$/)
    .default(`openai/${FAST_MODEL}`),
);

const configuration = z.object({
  TESTER_ARMY_CF_API_TOKEN: z.string().min(1),
  TESTER_ARMY_CF_ACCOUNT_ID: optionalSetting(
    z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .default(CF_ACCOUNT_ID),
  ),
  TESTER_ARMY_MODEL: testerArmyModelSetting,
});

export function modelConfiguration() {
  const result = configuration.safeParse({
    ...process.env,
    TESTER_ARMY_CF_API_TOKEN: localSecret(
      ["TESTER_ARMY_CF_API_TOKEN", "AI_GATEWAY_API_KEY"],
      { envFile: process.env.TESTER_ARMY_ENV_FILE },
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
  const provider = createOpenAI({
    apiKey: config.TESTER_ARMY_CF_API_TOKEN,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${config.TESTER_ARMY_CF_ACCOUNT_ID}/ai/v1`,
    headers: testerArmyGatewayHeaders(process.env.CI),
  });
  return provider.responses(config.TESTER_ARMY_MODEL);
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
