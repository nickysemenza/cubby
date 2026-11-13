/** A saved field question includes its stored basis, precedents and fully prepared model questions. */
import { z } from "zod";

import { preparedQuestion } from "~/server/ai/evaluation-inputs";
import { fieldAnswer } from "~/server/ai/fields/repo/field-answer";
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

/**
 * The value Cubby held at cutover and the record it held it on, written only
 * by the cutover migration and never produced. While the field's basis and
 * value still equal that record, the `fields` scope keeps the value without
 * asking (ADR 0029 section 11).
 */
export const fieldBaselineAsk = defineAsk({
  feature: "legacy:field",
  producer: "model",
  promptVersion: "legacy",
  input: z.object({
    entity: z.string(),
    recordId: z.uuid(),
    field: z.string(),
  }),
  output: z.object({ value: z.json(), record: z.record(z.string(), z.json()) }),
  policy: { outputRevision: "legacy-field.v1" },
  label: "Cubby's value at cutover",
});
