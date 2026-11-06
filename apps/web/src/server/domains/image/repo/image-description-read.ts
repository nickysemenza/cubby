import { type ImageId } from "@cubby/schemas/identifiers";
import { imageDescriptionConfirmationOwner } from "@cubby/schemas/image-processing";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries as getDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { image } from "~/server/db/retained-tables";

export async function readImageDescriptionConfirmations(
  db: RepositoryQueryInput,
  scope: { imageIds: readonly ImageId[] } | { shortcodes: readonly string[] },
) {
  const ids = "imageIds" in scope ? scope.imageIds : scope.shortcodes;
  if (!ids.length) return [];
  const rows = await getDb(db)
    .select({
      imageId: image.id,
      shortcode: image.shortcode,
      contentHash: image.descriptionContentHash,
      description: image.confirmedDescription,
      confirmedAt: image.descriptionConfirmedAt,
      owner: image.descriptionConfirmationOwner,
    })
    .from(image)
    .where(
      and(
        "imageIds" in scope
          ? inArray(image.id, [...scope.imageIds])
          : inArray(image.shortcode, [...scope.shortcodes]),
        notDeleted(image),
        eq(image.descriptionContentHash, image.sha256),
        isNotNull(image.confirmedDescription),
      ),
    );
  return rows.flatMap((row) =>
    row.description !== null && row.confirmedAt !== null
      ? [
          {
            ...row,
            description: row.description,
            confirmedAt: row.confirmedAt,
            owner: imageDescriptionConfirmationOwner
              .nullable()
              .parse(row.owner),
          },
        ]
      : [],
  );
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
