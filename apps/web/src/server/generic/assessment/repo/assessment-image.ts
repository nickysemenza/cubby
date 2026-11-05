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
import { suggestionTable, image } from "~/server/db/retained-tables";

/** Shared direct/batch selection verifies automatic effect receipts once per requested page. */
export async function readImageDescriptionConfirmations(
  db: RepositoryQueryInput,
  scope: { imageIds: readonly ImageId[] } | { shortcodes: readonly string[] },
) {
  const ids = "imageIds" in scope ? scope.imageIds : scope.shortcodes;
  if (!ids.length) return [];
  const rows = await getDb(db)
    .select({
      assessmentId: suggestionTable.id,
      imageId: image.id,
      shortcode: image.shortcode,
      contentHash: image.sha256,
      description: sql<string>`${suggestionTable.confirmedValue}->>'value'`,
      data: suggestionTable.data,
      // The confirmation's own time: later decisions also move `updatedAt`.
      confirmedAt:
        sql<Date>`coalesce((SELECT max((d->>'createdAt')::timestamp) FROM jsonb_array_elements(${suggestionTable.decisions}) d WHERE d @> ${JSON.stringify({ metadata: { kind: "assessment_application" } })}::jsonb), ${suggestionTable.updatedAt})`.mapWith(
          suggestionTable.updatedAt,
        ),
    })
    .from(suggestionTable)
    .innerJoin(image, eq(image.id, suggestionTable.recordId))
    .where(
      and(
        "imageIds" in scope
          ? inArray(image.id, [...scope.imageIds])
          : inArray(image.shortcode, [...scope.shortcodes]),
        currentImageDescriptionConfirmation(),
      ),
    )
    .orderBy(desc(suggestionTable.updatedAt));
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
