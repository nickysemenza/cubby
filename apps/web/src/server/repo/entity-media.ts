import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import type { EntityDisplayImagesOutput } from "@cubby/schemas/entity-media";

import type { Database, DrizzleTransaction } from "~/server/db";
import { resolvePublicEntityDisplayImages } from "~/server/repo/entity-display-image";

/**
 * The shared resolver joins public codes to identities in the same SQL read
 * as image selection. Missing, deleted, foreign, and external refs remain
 * explicit nulls so a bad link cannot erase neighboring thumbnails.
 */
export async function getEntityDisplayImages(
  db: Database | DrizzleTransaction,
  refs: readonly EntityRef[],
): Promise<EntityDisplayImagesOutput> {
  const uniqueRefs = [
    ...new Map(
      refs.map((ref) => [entityRefKey(ref.entityType, ref.entityId), ref]),
    ).values(),
  ];
  const images = await resolvePublicEntityDisplayImages(db, uniqueRefs);
  return Object.fromEntries(
    uniqueRefs.map((ref) => {
      const key = entityRefKey(ref.entityType, ref.entityId);
      return [key, images.get(key) ?? null];
    }),
  );
}
