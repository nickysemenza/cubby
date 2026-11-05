import { type ImageId } from "@cubby/schemas/identifiers";
import { imageDescriptionConfirmationOwner } from "@cubby/schemas/image-processing";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { currentImageDescriptionConfirmation } from "~/server/db/computed/image-description-confirmation";
import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import {
  assessmentState,
  assessment,
  image,
  feedback,
} from "~/server/db/retained-tables";

/** Shared direct/batch selection verifies automatic effect receipts once per requested page. */
export async function readImageDescriptionConfirmations(
  db: RepositoryQueryInput,
  scope: { imageIds: readonly ImageId[] } | { shortcodes: readonly string[] },
) {
  const ids = "imageIds" in scope ? scope.imageIds : scope.shortcodes;
  if (!ids.length) return [];
  const rows = await getDb(db)
    .select({
      assessmentId: assessmentState.id,
      imageId: image.id,
      shortcode: image.shortcode,
      contentHash: image.sha256,
      description: sql<string>`${assessmentState.confirmedValue}->>'value'`,
      data: assessmentState.data,
      confirmedAt:
        sql<Date>`coalesce((SELECT max(f."createdAt") FROM ${feedback} f WHERE f."assessmentId"=${assessmentState.id} AND f.metadata @> ${JSON.stringify({ kind: "assessment_application" })}::jsonb AND f.receipt @> ${JSON.stringify({ applied: true })}::jsonb),(${assessmentState.data}->>'confirmedAt')::timestamp,${assessmentState.updatedAt})`.mapWith(
          assessmentState.updatedAt,
        ),
    })
    .from(assessmentState)
    .innerJoin(assessment, eq(assessment.id, assessmentState.id))
    .innerJoin(image, eq(image.id, assessmentState.recordId))
    .where(
      and(
        "imageIds" in scope
          ? inArray(image.id, [...scope.imageIds])
          : inArray(image.shortcode, [...scope.shortcodes]),
        currentImageDescriptionConfirmation(),
      ),
    )
    .orderBy(desc(assessmentState.updatedAt));
  const prepared = [
    ...new Map(rows.map((row) => [row.assessmentId, row])).values(),
  ].flatMap((row) => {
    const ownership = z
      .object({
        confirmationOwner: imageDescriptionConfirmationOwner.optional(),
      })
      .safeParse(row.data ?? {});
    return ownership.success
      ? [{ ...row, owner: ownership.data.confirmationOwner ?? null }]
      : [];
  });
  return prepared;
}

export async function readConfirmedDescription(db: Database, imageId: ImageId) {
  const [row] = await readImageDescriptionConfirmations(db, {
    imageIds: [imageId],
  });
  return row
    ? {
        description: row.description,
        confirmedAt: row.confirmedAt,
        owner: row.owner,
      }
    : null;
}
