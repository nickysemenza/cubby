import { assessmentSubjects } from "@cubby/schemas/assessment";
import { SYSTEM_USER_ID } from "@cubby/schemas/context";
import { CORRECTION_OUTCOME_RECEIPT_KIND } from "@cubby/schemas/suggestion-correction";
import { and, or, sql } from "drizzle-orm";

/** Source proof shared by composable classification SQL and repository readers.
 * Inner columns stay explicitly qualified: relational extras remap column chunks
 * to the outer entity alias, including columns inside nested SQL.
 */
export function currentImageDescriptionConfirmation() {
  const owner = sql`"AssessmentState"."data"->${"confirmationOwner"}`;
  const automatic = sql`EXISTS (SELECT 1 FROM "Feedback" f
    WHERE f."assessmentId" = "AssessmentState"."id"
      AND f."operationId" = concat(${"correction:"}::text, ${owner}->>${"sourceFeedbackId"}, ${":"}::text, "AssessmentState"."id"::text)
      AND f.authority = ${"automatic"} AND f."actorUserId" = ${SYSTEM_USER_ID}
      AND f.intent = ${"history"} AND f.correction = ${JSON.stringify({ present: false })}::jsonb AND f.suppression IS NULL
      AND f.metadata->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND}
      AND f.metadata->>${"sourceFeedbackId"} = ${owner}->>${"sourceFeedbackId"}
      AND f.metadata->>${"sourceApplicationFeedbackId"} = ${owner}->>${"sourceApplicationFeedbackId"}
      AND f.metadata->>${"sourceActorUserId"} = ${owner}->>${"sourceActorUserId"}
      AND ${owner}->>${"targetAssessmentId"} = "AssessmentState"."id"::text
      AND pg_input_is_valid(${owner}->>${"effectId"}, ${"uuid"})
      AND f.receipt->>${"status"} = ${"applied"}
      AND f.receipt->${"receipt"}->>${"kind"} = ${"image_description"}
      AND f.receipt->${"receipt"}->>${"recordId"} = "Image"."id"::text
      AND f.receipt->${"receipt"}->>${"contentHash"} = "Image"."sha256"
      AND f.receipt->${"receipt"}->>${"description"} = "AssessmentState"."confirmedValue"->>${"value"}
      AND f.receipt->${"receipt"}->${"owner"} = ${owner})`;
  return and(
    sql`"Assessment"."family" = ${"image_description"}`,
    sql`"AssessmentState"."family" = ${"image_description"}`,
    sql`"AssessmentState"."entity" = ${"image"}`,
    sql`"AssessmentState"."active" = true`,
    sql`"Image"."deletedAt" IS NULL`,
    sql`"Assessment"."fingerprint" = "Image"."sha256"`,
    sql`"AssessmentState"."fingerprint" = "Image"."sha256"`,
    sql`"Assessment"."subject"->>${assessmentSubjects.image_description.keyof().enum.contentHash} = "Image"."sha256"`,
    sql`"Assessment"."subject"->>${assessmentSubjects.image_description.keyof().enum.recordId} = "Image"."id"::text`,
    sql`"AssessmentState"."confirmedValue" @> ${JSON.stringify({ present: true })}::jsonb`,
    sql`jsonb_typeof("AssessmentState"."confirmedValue"->${"value"}) = ${"string"}`,
    or(
      sql`${owner} IS NULL`,
      and(
        sql`${owner}->>${"kind"} = ${"member"}`,
        sql`pg_input_is_valid(${owner}->>${"effectId"}, ${"uuid"})`,
        sql`pg_input_is_valid(${owner}->>${"commandFeedbackId"}, ${"uuid"})`,
        sql`length(${owner}->>${"actorUserId"}) > 0`,
      ),
      and(sql`${owner}->>${"kind"} = ${"correction"}`, automatic),
    ),
  );
}
