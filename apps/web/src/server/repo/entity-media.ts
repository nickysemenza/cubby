import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import type { EntityDisplayImagesOutput } from "@cubby/schemas/entity-media";

import type { Database, DrizzleTransaction } from "~/server/db";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";

const isShortcodeEntity = (
  entity: EntityRef["entityType"],
): entity is ShortcodeEntity =>
  shortcodeEntities.some((item) => item === entity);

/**
 * Resolve public refs in entity batches before applying the single canonical
 * display-image policy. Missing, deleted, foreign, and external refs remain
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
  const refsByEntity = new Map<ShortcodeEntity, EntityRef[]>();
  for (const ref of uniqueRefs) {
    if (!isShortcodeEntity(ref.entityType)) continue;
    const bucket = refsByEntity.get(ref.entityType);
    if (bucket) bucket.push(ref);
    else refsByEntity.set(ref.entityType, [ref]);
  }

  const privateRefs = new Map<
    string,
    { entityType: ShortcodeEntity; entityId: string }
  >();
  await Promise.all(
    [...refsByEntity].map(async ([entity, entityRefs]) => {
      const resolved = await resolveLiveShortcodes(
        db,
        entityRefs.map((ref) => ref.entityId),
        entity,
      );
      for (const ref of entityRefs) {
        const id = resolved.get(ref.entityId);
        if (id) {
          privateRefs.set(entityRefKey(ref.entityType, ref.entityId), {
            entityType: entity,
            entityId: id,
          });
        }
      }
    }),
  );

  const images = await resolveEntityDisplayImages(db, [
    ...privateRefs.values(),
  ]);
  return Object.fromEntries(
    uniqueRefs.map((ref) => {
      const key = entityRefKey(ref.entityType, ref.entityId);
      const privateRef = privateRefs.get(key);
      return [
        key,
        privateRef
          ? (images.get(
              entityRefKey(privateRef.entityType, privateRef.entityId),
            ) ?? null)
          : null,
      ];
    }),
  );
}
