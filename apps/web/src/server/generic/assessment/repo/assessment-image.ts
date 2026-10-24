import { assessmentSubjects } from "@cubby/schemas/assessment";
import { type ImageId } from "@cubby/schemas/identifiers";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  assessmentState,
  assessment,
  image,
  feedback,
} from "~/server/db/retained-tables";

/** Content freshness is shared by direct and batch readers; propagation still requires its receipt authority. */
export function currentImageDescriptionConfirmation() {
  return and(
    eq(assessment.family, "image_description"),
    eq(assessmentState.family, "image_description"),
    eq(assessmentState.entity, "image"),
    eq(assessmentState.active, true),
    notDeleted(image),
    eq(assessment.fingerprint, image.sha256),
    eq(assessmentState.fingerprint, image.sha256),
    sql`${assessment.subject}->>${assessmentSubjects.image_description.keyof().enum.contentHash} = ${image.sha256}`,
    sql`${assessment.subject}->>${assessmentSubjects.image_description.keyof().enum.recordId} = ${image.id}::text`,
    sql`${assessmentState.confirmedValue} @> ${JSON.stringify({ present: true })}::jsonb`,
    sql`jsonb_typeof(${assessmentState.confirmedValue}->${"value"}) = ${"string"}`,
  );
}

export async function readConfirmedDescription(db: Database, imageId: ImageId) {
  const [row] = await getDb(db)
    .select({
      correction: assessmentState.confirmedValue,
      confirmedAt:
        sql<Date>`coalesce((SELECT max(f."createdAt") FROM ${feedback} f WHERE f."assessmentId"=${assessmentState.id} AND f.metadata @> ${JSON.stringify({ kind: "assessment_application" })}::jsonb AND f.receipt @> ${JSON.stringify({ applied: true })}::jsonb),(${assessmentState.data}->>'confirmedAt')::timestamp,${assessmentState.updatedAt})`.mapWith(
          assessmentState.updatedAt,
        ),
    })
    .from(assessmentState)
    .innerJoin(assessment, eq(assessment.id, assessmentState.id))
    .innerJoin(image, eq(image.id, assessmentState.recordId))
    .where(and(eq(image.id, imageId), currentImageDescriptionConfirmation()))
    .orderBy(desc(assessmentState.updatedAt))
    .limit(1);
  return row?.correction?.present
    ? {
        description: z.string().parse(row.correction.value),
        confirmedAt: row.confirmedAt,
      }
    : null;
}
