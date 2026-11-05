import { assessmentSubjects } from "@cubby/schemas/assessment";
import { and, or, sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

/** Source proof shared by composable classification SQL and repository readers.
 * Inner columns stay explicitly qualified: relational extras remap column chunks
 * to the outer entity alias, including columns inside nested SQL.
 */
export function currentImageDescriptionConfirmation() {
  const owner = sql`"Suggestion"."data"->${"confirmationOwner"}`;
  return and(
    sql`"Suggestion"."family" = ${"image_description"}`,
    sql`"Suggestion"."entity" = ${"image"}`,
    sql`"Suggestion"."active" = true`,
    sql`${notDeleted("Image")}`,
    sql`"Suggestion"."fingerprint" = "Image"."sha256"`,
    sql`"Suggestion"."subject"->>${assessmentSubjects.image_description.keyof().enum.contentHash} = "Image"."sha256"`,
    sql`"Suggestion"."subject"->>${assessmentSubjects.image_description.keyof().enum.recordId} = "Image"."id"::text`,
    sql`"Suggestion"."confirmedValue" @> ${JSON.stringify({ present: true })}::jsonb`,
    sql`jsonb_typeof("Suggestion"."confirmedValue"->${"value"}) = ${"string"}`,
    or(
      sql`${owner} IS NULL`,
      and(
        sql`${owner}->>${"kind"} = ${"member"}`,
        sql`pg_input_is_valid(${owner}->>${"effectId"}, ${"uuid"})`,
        sql`pg_input_is_valid(${owner}->>${"commandFeedbackId"}, ${"uuid"})`,
        sql`length(${owner}->>${"actorUserId"}) > 0`,
      ),
    ),
  );
}
