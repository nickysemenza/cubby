import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import {
  assessmentJudgments,
  assessmentSubjects,
  type AssessmentCorrection,
} from "@cubby/schemas/assessment";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  assertApplicationReceipt,
  recordFeedback,
} from "~/server/repo/assessment";
import { latestFieldWrite } from "~/server/repo/audit-log";
import { getDb, withTransactionDatabase } from "~/server/repo/database-helpers";
import { SHORTCODE_TABLE } from "~/server/repo/generated/shortcode-tables.gen";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

/** Saving a draft is a separate fact. Verify stored value; never rewrite a later edit. */
export async function acknowledgeSavedField(
  db: Database,
  context: EntityKernelContext,
  prediction: typeof assessment.$inferSelect,
  input: {
    recordId: string;
    operationId: string;
    correction: AssessmentCorrection;
    commandFeedback: typeof feedback.$inferSelect;
  },
) {
  const [previous] = await getDb(db)
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.assessmentId, prediction.id),
        eq(feedback.operationId, `receipt:${input.operationId}`),
      ),
    )
    .limit(1);
  if (previous) {
    assertApplicationReceipt(previous, input.commandFeedback, "saved_field");
    return suggestionAcceptanceReceipt.parse(previous.receipt);
  }
  const subject = assessmentSubjects.field.parse(prediction.subject);
  const judgment = assessmentJudgments.field.parse(prediction.judgment);
  const entity = fieldSuggestionsInput.shape.entity.parse(subject.entity);
  const table = SHORTCODE_TABLE[entity];
  const id = await resolveOrThrow(db, entity, input.recordId);
  return withTransactionDatabase(db, async (transactionDb) => {
    const [row] = await getDb(transactionDb)
      .select({ value: sql<unknown>`to_jsonb(${table})->>${subject.field}` })
      .from(table)
      .where(eq(table.id, id))
      .for("update")
      .limit(1);
    if (!row) throw new Error("The saved field target no longer exists");
    if (subject.recordId !== null && subject.recordId !== id)
      throw new Error(
        "The saved field target differs from the original Assessment",
      );
    const raw = z.string().nullable().parse(row.value);
    const proposed = input.correction.present
      ? input.correction.value
      : judgment.value;
    const field = entityFieldByKey(entity, subject.field);
    let expected = proposed;
    const reference = z
      .enum(shortcodeEntities)
      .safeParse(field?.reference?.entity);
    if (reference.success && typeof proposed === "string")
      expected = await resolveOrThrow(transactionDb, reference.data, proposed);
    if (judgment.operation === "remove" && !input.correction.present) {
      const saved = z
        .array(z.string())
        .parse(raw === null ? [] : JSON.parse(raw));
      const removals = z
        .array(z.object({ value: z.string() }))
        .parse(judgment.removals);
      if (removals.some((removal) => saved.includes(removal.value)))
        throw new Error("The saved field still contains a reviewed removal");
    } else if (
      raw !==
      (expected === null
        ? null
        : typeof expected === "string"
          ? expected
          : JSON.stringify(expected))
    )
      throw new Error("The saved field changed from the reviewed value");
    const write = await latestFieldWrite(
      transactionDb,
      entity,
      id,
      subject.field,
    );
    const receipt = suggestionAcceptanceReceipt.parse({
      mode: "member",
      runId: context.actorContext.runId,
      auditIds: write ? [write.id] : [],
      acceptedAt: new Date().toISOString(),
      reason: input.correction.present
        ? "member_correction"
        : "member_acceptance",
      confidence: null,
      threshold: null,
    });
    await recordFeedback(transactionDb, {
      assessmentId: prediction.id,
      operationId: `receipt:${input.operationId}`,
      verdict: input.correction.present ? "wrong" : "correct",
      correction: input.correction,
      intent: "apply",
      authority: "member",
      actorUserId: context.actorContext.userId,
      receipt: z.json().parse(receipt),
      metadata: {
        kind: "saved_field",
        commandFeedbackId: input.commandFeedback.id,
        entity,
        recordId: id,
        field: subject.field,
      },
    });
    await getDb(transactionDb)
      .insert(assessmentState)
      .values({
        id: prediction.id,
        family: "field",
        entity,
        recordId: id,
        field: subject.field,
        status: "applied",
        active: false,
        acceptanceReceipt: receipt,
        suggestedValue: proposed,
        runId: prediction.producer?.runId ?? null,
      })
      .onConflictDoUpdate({
        target: assessmentState.id,
        set: { status: "applied", acceptanceReceipt: receipt },
      });
    return receipt;
  });
}
