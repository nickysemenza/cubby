/**
 * The field Ask (ADR 0029 section 1): one decision-model question about one
 * saved record's field. Its declared input is what the `fields` reconciler
 * loaded: the record's stored basis and field columns and its precedents.
 * The producer (`produce.ts`) reads the record through the canonical
 * selected-detail reader for labels and effective values, and refuses to
 * answer when the stored columns no longer equal the input, so an Answer
 * always describes the input its hash covers.
 */
import { z } from "zod";

import { precedentSchema } from "~/server/ai/fields/repo/precedents";
import { produceModel } from "~/server/ai/model-call-context";
import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { defineAsk } from "~/server/kernel/api";

export const fieldAskInput = z.object({
  entity: z.string(),
  field: z.string(),
  recordId: z.uuid(),
  /** The record's stored basis and field columns, by column key. */
  row: z.record(z.string(), z.json()),
  precedents: z.array(precedentSchema),
});
export type FieldAskInput = z.infer<typeof fieldAskInput>;

const proposalValue = z.object({
  /** The value as the column stores it (a reference's id). */
  value: z.string(),
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
    produceModel(async () =>
      (await import("./produce")).produceFieldAnswer(
        context.db,
        input,
        context.runId,
      ),
    ),
});
