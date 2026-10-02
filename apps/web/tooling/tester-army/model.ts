import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";

const configuration = z.object({
  TESTER_ARMY_CF_API_TOKEN: z.string().min(1),
  TESTER_ARMY_CF_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
  TESTER_ARMY_CF_GATEWAY_ID: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("cubby-testing"),
  TESTER_ARMY_MODEL: z
    .string()
    .regex(/^openai\/gpt-[a-z0-9.-]+$/)
    .default("openai/gpt-6-luna"),
});

export function modelConfiguration() {
  const result = configuration.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Tester Army configuration missing or invalid: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}

export function testerArmyModel() {
  const config = modelConfiguration();
  const provider = createOpenAI({
    apiKey: config.TESTER_ARMY_CF_API_TOKEN,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${config.TESTER_ARMY_CF_ACCOUNT_ID}/ai/v1`,
    headers: {
      "cf-aig-gateway-id": config.TESTER_ARMY_CF_GATEWAY_ID,
      "cf-aig-skip-cache": "true",
      "cf-aig-metadata": JSON.stringify({
        purpose: "synthetic-e2e",
        revision: process.env.GITHUB_SHA ?? "local",
      }),
    },
  });
  return provider.responses(config.TESTER_ARMY_MODEL);
}

export const testerArmyProviderOptions = {
  openai: { reasoningEffort: "medium", store: false },
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
            type: "image",
            image: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGfoAAAAASUVORK5CYII=",
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
