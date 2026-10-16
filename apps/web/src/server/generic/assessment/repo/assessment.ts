import {
  assessmentChildHandle,
  assessmentPublication,
  assessmentJudgments,
  assessmentProjectionTargets,
  feedbackEvent,
} from "@cubby/schemas/assessment";
import { and, eq, sql } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import {
  assessment,
  assessmentState,
  feedback,
} from "~/server/db/retained-tables";

/** A matching operation ID alone never proves that a domain mutation committed. */
export function assertApplicationReceipt(
  receipt: typeof feedback.$inferSelect,
  command: typeof feedback.$inferSelect,
  kind: string,
) {
  const metadata = z
    .object({ kind: z.string(), commandFeedbackId: assessmentChildHandle })
    .safeParse(receipt.metadata);
  if (
    !metadata.success ||
    metadata.data.kind !== kind ||
    metadata.data.commandFeedbackId !== command.id ||
    receipt.assessmentId !== command.assessmentId ||
    receipt.authority !== "member" ||
    receipt.intent !== "apply" ||
    receipt.actorUserId !== command.actorUserId ||
    receipt.suppression !== null ||
    receipt.receipt === null
  )
    throw new Error("Invalid immutable application receipt for this command");
}

/** A publication key names exact immutable evidence, never a mutable slot. */
export async function publishAssessment(
  db: Database,
  raw: z.input<typeof assessmentPublication>,
  projection: Partial<typeof assessmentState.$inferInsert> = {},
) {
  const input = assessmentPublication.parse(raw);
  assessmentJudgments[input.family].parse(input.judgment);
  const suggestedValue =
    projection.suggestedValue === undefined
      ? input.judgment
      : projection.suggestedValue;
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const [inserted] = await client
      .insert(assessment)
      .values({
        ...input,
        judgment: input.judgment === null ? sql`'null'::jsonb` : input.judgment,
      })
      .onConflictDoNothing({ target: assessment.publicationKey })
      .returning();
    const row =
      inserted ??
      (
        await client
          .select()
          .from(assessment)
          .where(eq(assessment.publicationKey, input.publicationKey))
          .limit(1)
      )[0];
    if (!row) throw new Error("Assessment publication returned no row");
    if (!isEqual(input, assessmentPublication.parse(row)))
      throw new Error(
        "Assessment publication retry changed immutable evidence",
      );
    const target =
      input.subject.kind === "email_link" && input.subject.recordId === null
        ? { entity: "orderMailEvent", recordId: input.subject.eventId }
        : { entity: input.subject.entity, recordId: input.subject.recordId };
    if (inserted && target.recordId !== null) {
      const currentTarget = assessmentProjectionTargets[input.family].parse({
        ...target,
        ...projection,
      });
      await client.insert(assessmentState).values({
        id: row.id,
        family: input.family,
        ...currentTarget,
        field: input.subject.kind === "field" ? input.subject.field : "",
        fingerprint: input.fingerprint,
        ...projection,
        suggestedValue:
          suggestedValue === null ? sql`'null'::jsonb` : suggestedValue,
      });
    }
    return row;
  });
}

/** Recording a grade is independent of applying a correction or changing authority. */
export async function recordFeedback(
  db: Database,
  raw: z.input<typeof feedbackEvent>,
) {
  const input = feedbackEvent.parse(raw);
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const [prediction] = await client
      .select()
      .from(assessment)
      .where(eq(assessment.id, input.assessmentId))
      .limit(1);
    if (!prediction) throw new Error("Assessment not found");
    if (!prediction.served && input.authority === "member")
      throw new Error(
        "Unserved trial assessments are not member review candidates",
      );
    if (
      input.authority === "evaluation" &&
      (input.intent !== "history" || input.suppression)
    )
      throw new Error(
        "Evaluation Feedback cannot apply or suppress operational results",
      );
    const [inserted] = await client
      .insert(feedback)
      .values(input)
      .onConflictDoNothing({
        target: [feedback.assessmentId, feedback.operationId],
      })
      .returning();
    const row =
      inserted ??
      (
        await client
          .select()
          .from(feedback)
          .where(
            and(
              eq(feedback.assessmentId, input.assessmentId),
              eq(feedback.operationId, input.operationId),
            ),
          )
          .limit(1)
      )[0];
    if (!row) throw new Error("Feedback publication returned no row");
    if (!isEqual(input, feedbackEvent.parse(row)))
      throw new Error("Immutable Feedback retry changed its event");
    return row;
  });
}
