/** Model calls owe Answers to the kernel; transports own no application cache. */
import { runEntityId } from "@cubby/schemas/identifiers";
import {
  supportedChatModelSchema,
  supportedDecisionModelSchema,
} from "@cubby/shared/ai/models";
import { z } from "zod";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { produceModel } from "~/server/ai/model-call-context";
import { decisionImageSchema } from "~/server/ai/policy/decision-choice";
import { AI_FEATURES, RUN_SUMMARY_FEATURE } from "~/server/ai/policy/features";
import type { AiFeature } from "~/server/ai/policy/features";
import type { Database } from "~/server/db";
import { defineAsk } from "~/server/kernel/api";

const source = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("url"),
    value: z.string(),
    mimeType: z.string().optional(),
  }),
  z.object({
    type: z.literal("inline"),
    value: z.string(),
    mimeType: z.string(),
  }),
]);
export const modelRequest = z.object({
  systemPrompts: z.array(z.string()),
  messages: z.array(
    z.object({
      role: z.literal("user"),
      content: z.union([
        z.string(),
        z.array(
          z.union([
            z.object({ type: z.literal("text"), content: z.string() }),
            z.object({ type: z.literal("image"), source }),
            z.object({
              type: z.literal("document"),
              source: z.object({
                type: z.enum(["url", "inline"]),
                value: z.string(),
                mimeType: z.string(),
              }),
            }),
          ]),
        ),
      ]),
    }),
  ),
});
export const modelInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("structured"),
    request: modelRequest,
    model: supportedChatModelSchema,
    revision: z.json().optional(),
  }),
  z.object({
    kind: z.literal("choice"),
    model: supportedDecisionModelSchema,
    subject: z.string(),
    rules: z.string(),
    choices: z.array(z.string()),
    allowNone: z.boolean(),
    images: z.array(decisionImageSchema).optional(),
  }),
]);
export const modelOutput = z.object({
  value: z.json(),
  model: z.string().nullable(),
});
export type ModelInput = z.infer<typeof modelInput>;
export type ModelOutput = z.infer<typeof modelOutput>;

/** Credit, plan and paid admission is checked before a model Ask becomes sent. */
export async function admitModel(
  db: Database,
  tier: AiFeature["tier"],
): Promise<void> {
  if (tier === "decision" || tier === "embedding") return;
  const status = await (await import("./funding")).readAiFundingStatus(db);
  if (
    [status.credit, status.openaiCredit, status.plan, status.paid].some(
      (route) => route.availability.usable,
    )
  )
    return;
  throw new AiBudgetExhaustedError(status);
}

const featureName = (feature: AiFeature) =>
  feature.feature === "field-suggestion"
    ? "field-suggestion.choice"
    : feature.feature;
const declarations = [...AI_FEATURES, RUN_SUMMARY_FEATURE].filter(
  (feature) => feature.tier !== "embedding",
);

export const modelAsks = declarations.map((feature) =>
  defineAsk({
    feature: featureName(feature),
    producer: "model",
    promptVersion: feature.promptVersion,
    input: modelInput,
    output: modelOutput,
    policy: {
      tier: feature.tier,
      outputRevision:
        "schema" in feature
          ? JSON.stringify(z.toJSONSchema(feature.schema))
          : "decision-choice.v1",
    },
    label: feature.feature,
    admit: (db) => admitModel(db, feature.tier),
    produce: (input, { db, runId }) =>
      produceModel(async () => {
        const usage = {
          db,
          operation: feature.feature,
          runId: runId ? runEntityId.parse(runId) : undefined,
          applicationCache: false,
        };
        if (input.kind === "choice") {
          if (feature.tier !== "decision")
            throw new Error("A structured feature cannot answer a choice Ask");
          const value = await (
            await import("./decision-model")
          ).runDecisionChoice({
            feature,
            ...input,
            usage,
            decisionModel: input.model,
          });
          return {
            output: { value: z.json().parse(value), model: input.model },
            model: input.model,
            tier: feature.tier,
          };
        }
        if (!("schema" in feature))
          throw new Error("A choice feature cannot answer a structured Ask");
        let model: string | null = null;
        const value = await (
          await import("./run-feature")
        ).runStructuredFeature<unknown>(
          { ...feature, model: input.model },
          input.request,
          {
            ...usage,
            onAnswered: (answered) => {
              model = answered;
            },
          },
        );
        return {
          output: { value: z.json().parse(value), model },
          model,
          tier: feature.tier,
        };
      }),
  }),
);

export function modelAskFor(feature: AiFeature) {
  const found = modelAsks.find((ask) => ask.feature === featureName(feature));
  if (!found) throw new Error(`No model Ask declared for ${feature.feature}`);
  return {
    ...found,
    promptVersion: feature.promptVersion,
    policy: { ...found.policy, tier: feature.tier },
  };
}
