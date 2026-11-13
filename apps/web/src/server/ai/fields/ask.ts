/** A saved field question includes its stored basis, precedents and fully prepared model questions. */
import { z } from "zod";

import { preparedQuestion } from "~/server/ai/evaluation-inputs";
import { precedentSchema } from "~/server/ai/fields/repo/precedents";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { defineAsk } from "~/server/kernel/api";

export const fieldAskInput = z.object({
  entity: z.string(),
  field: z.string(),
  recordId: z.uuid(),
  /** The record's stored basis and field columns, by column key. */
  row: z.record(z.string(), z.json()),
  precedents: z.array(precedentSchema),
  questions: z.array(preparedQuestion).optional(),
});
export type FieldAskInput = z.infer<typeof fieldAskInput>;

const proposalValue = z.object({
  /** The value as the column stores it (a reference's id). */
  value: z.union([z.string(), z.array(z.string())]),
  label: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const fieldAnswer = z.object({
  proposal: proposalValue
    .extend({ runnerUp: proposalValue.nullable() })
    .nullable(),
  /** Why there is or is not a proposal: `pick`, `none`, or a skip reason. */
  outcome: z.string(),
});
export type FieldAnswer = z.infer<typeof fieldAnswer>;

export const fieldAsk = defineAsk({
  feature: FIELD_SUGGESTION_FEATURE.feature,
  producer: "model",
  promptVersion: FIELD_SUGGESTION_FEATURE.promptVersion,
  input: fieldAskInput,
  output: fieldAnswer,
  policy: { tier: FIELD_SUGGESTION_FEATURE.tier },
  label: "Cubby's answer",
  admit: async (db, context) =>
    (await import("~/server/ai/model-asks")).admitModel(
      db,
      "decision",
      context,
    ),
  // Loaded on call: the producer's graph (rosters, domain readers) stays out
  // of the module list the kernel and the write boundary load.
  produce: async (input, context) =>
    (await import("./produce")).produceFieldAnswer(
      context.db,
      input,
      context.runId,
    ),
});
