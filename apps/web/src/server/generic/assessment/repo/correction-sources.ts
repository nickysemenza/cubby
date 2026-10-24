import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentChildHandle,
  assessmentSubjects,
} from "@cubby/schemas/assessment";
import {
  suggestionCorrectionSource,
  suggestionCorrectionTarget,
  correctionAuthorityReceiptKinds,
} from "@cubby/schemas/suggestion-correction";
import { CORRECTION_OUTCOME_RECEIPT_KIND } from "@cubby/schemas/suggestion-correction";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import { assertApplicationReceipt } from "~/server/generic/assessment/repo/assessment";

const application = alias(feedback, "correction_application");
const receiptMetadata = z.object({
  kind: correctionAuthorityReceiptKinds,
  commandFeedbackId: assessmentChildHandle,
});
export const fieldCorrectionKey = (evidence: unknown) =>
  z.object({ correctionKey: z.string().min(1).nullable() }).safeParse(evidence)
    .data?.correctionKey ?? null;

/** A failed apply leaves review Feedback behind; only its bound receipt grants authority. */
async function confirmedSources(db: Database, where: SQL | undefined) {
  const rows = await getDb(db)
    .select({ command: feedback, application, prediction: assessment })
    .from(feedback)
    .innerJoin(assessment, eq(assessment.id, feedback.assessmentId))
    .innerJoin(
      application,
      and(
        eq(application.assessmentId, feedback.assessmentId),
        sql`${application.metadata}->>'commandFeedbackId' = ${feedback.id}::text`,
        inArray(
          sql<string>`${application.metadata}->>${"kind"}`,
          correctionAuthorityReceiptKinds.options,
        ),
      ),
    )
    .where(
      and(
        eq(feedback.authority, "member"),
        eq(feedback.intent, "apply"),
        eq(assessment.served, true),
        sql`${feedback.correction}->>${"present"} = ${"true"}`,
        where,
      ),
    )
    .orderBy(asc(feedback.id));
  const confirmed = new Map<
    string,
    z.infer<typeof suggestionCorrectionSource>
  >();
  for (const { command, application: receipt, prediction } of rows) {
    const metadata = receiptMetadata.parse(receipt.metadata);
    assertApplicationReceipt(receipt, command, metadata.kind);
    if (!command.correction.present || !command.actorUserId)
      throw new Error(
        "A confirmed correction requires its member and corrected value",
      );
    const source = suggestionCorrectionSource.parse({
      feedbackId: command.id,
      applicationFeedbackId: receipt.id,
      assessmentId: prediction.id,
      family: prediction.family,
      subject: prediction.subject,
      judgment: prediction.judgment,
      evidence: prediction.evidence,
      correctedValue: command.correction.value,
      actorUserId: command.actorUserId,
      applicationReceipt: receipt.receipt,
      fieldApplicationReceipt: z
        .object({
          fieldApplicationReceipt:
            suggestionCorrectionSource.shape.fieldApplicationReceipt,
        })
        .parse(receipt.metadata).fieldApplicationReceipt,
    });
    // Saved-field application also has a generic command receipt. Its typed
    // field receipt is the single canonical authority, not a second root.
    const previous = confirmed.get(command.id);
    const canonical =
      !previous || metadata.kind === "saved_field" ? source : previous;
    confirmed.set(command.id, {
      ...canonical,
      fieldApplicationReceipt:
        source.fieldApplicationReceipt ??
        previous?.fieldApplicationReceipt ??
        null,
    });
  }
  return [...confirmed.values()];
}

export async function readConfirmedCorrection(
  db: Database,
  feedbackId: string,
) {
  const [source] = await confirmedSources(db, eq(feedback.id, feedbackId));
  return source ?? null;
}

/** Exact input keys bound the query; legacy evidence receives no invented scope. */
export async function readFieldCorrectionSources(db: Database, key: string) {
  return confirmedSources(
    db,
    and(
      eq(assessment.family, "field"),
      sql`${assessment.evidence}->>'correctionKey' = ${key}`,
    ),
  );
}

/** Skip input preparation when this field has never had confirmed correction authority. */
export async function hasFieldCorrectionSources(
  db: Database,
  entity: string,
  field: string,
) {
  return (
    (
      await confirmedSources(
        db,
        and(
          eq(assessment.family, "field"),
          sql`${assessment.subject}->>'entity' = ${entity}`,
          sql`${assessment.subject}->>${assessmentSubjects.field.keyof().enum.field} = ${field}`,
        ),
      )
    ).length > 0
  );
}

export async function readCorrectionTarget(db: Database, assessmentId: string) {
  const [row] = await getDb(db)
    .select({ prediction: assessment, state: assessmentState })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(eq(assessment.id, assessmentId))
    .limit(1);
  if (!row) return null;
  const [receipt] = await getDb(db)
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.assessmentId, assessmentId),
        eq(feedback.authority, "automatic"),
        eq(feedback.intent, "apply"),
        sql`${feedback.metadata}->>${"kind"} = ${correctionAuthorityReceiptKinds.enum.assessment_application}`,
      ),
    )
    .orderBy(asc(feedback.createdAt), asc(feedback.id))
    .limit(1);
  if (receipt) {
    const metadata = receiptMetadata.parse(receipt.metadata);
    const [command] = await getDb(db)
      .select()
      .from(feedback)
      .where(eq(feedback.id, metadata.commandFeedbackId))
      .limit(1);
    if (!command)
      throw new Error("Original automatic application has no command Feedback");
    assertApplicationReceipt(receipt, command, "assessment_application");
  }
  return suggestionCorrectionTarget.parse({
    assessmentId,
    family: row.prediction.family,
    subject: row.prediction.subject,
    judgment: row.prediction.judgment,
    evidence: row.prediction.evidence,
    fingerprint: row.state.fingerprint,
    status: row.state.status,
    applicationFeedbackId: receipt?.id ?? null,
    applicationReceipt: receipt?.receipt ?? null,
  });
}

export async function correctionTargetIds(
  db: Database,
  input: {
    sourceAssessmentId: string;
    correctionKey: string;
    after: string | null;
    limit: number;
  },
) {
  return getDb(db)
    .select({ id: assessment.id })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .where(
      and(
        eq(assessment.family, "field"),
        eq(assessment.served, true),
        sql`${assessment.id} <> ${input.sourceAssessmentId}::uuid`,
        sql`${assessment.evidence}->>'correctionKey' = ${input.correctionKey}`,
        or(
          inArray(assessmentState.status, ["pending", "applied"]),
          sql`EXISTS (SELECT 1 FROM ${feedback} effect WHERE effect."assessmentId"=${assessment.id}
            AND effect.metadata->>${"kind"}=${CORRECTION_OUTCOME_RECEIPT_KIND}
            AND effect.receipt->>'status'=${suggestionStatus.enum.applied})`,
        ),
        input.after ? sql`${assessment.id} > ${input.after}::uuid` : undefined,
      ),
    )
    .orderBy(asc(assessment.id))
    .limit(input.limit);
}
