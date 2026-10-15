import type { GalleryEntity } from "@cubby/schemas/entity-manifest";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import type { AttachableImageEntity } from "@cubby/schemas/image";
import type { AnyColumn, GetColumnData } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  applyImageOrder,
  associatePendingImages,
  nextImageSortOrder,
  type ImageJoinBinding,
  type ImageJoinTable,
} from "~/server/db/helpers";
import {
  resolveAllOrThrow,
  resolveAllPresent,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import { detachImagesFromEntity } from "./image";

/**
 * The shared image-sync body behind every gallery entity's update path:
 * reorder existing images (first = cover) → detach removed ones (reaping any
 * Image row/R2 object nothing else still references, via
 * `detachImagesFromEntity`) → attach newly pending ones, appended after the
 * reordered set. All three fields are public `IMG-` shortcodes, resolved to
 * uuids here — right before the lower-level helpers above, which still take
 * raw `Image.id`s.
 *
 * `unresolved` controls what an `IMG-` code that does not resolve to a live
 * Image does: `"drop"` (the default) silently ignores it, matching the
 * long-standing product/location/recipe/purchase behavior where a stale or
 * already-detached code is a no-op. `"throw"` surfaces
 * `REFERENCED_RECORD_MISSING` instead — gardenEntry's existing behavior,
 * preserved as-is by this extraction rather than silently loosened.
 */
export async function syncEntityImages<
  E extends GalleryEntity,
  TTable extends ImageJoinTable,
  TParentColumn extends AnyColumn,
>(
  tx: DrizzleTransaction,
  entity: E,
  binding: ImageJoinBinding<TTable, TParentColumn>,
  parentId: GetColumnData<TParentColumn>,
  data: {
    pendingImageIds?: readonly string[] | null;
    removeImageIds?: readonly string[] | null;
    imageOrder?: readonly string[] | null;
  },
  options?: { unresolved?: "drop" | "throw" },
): Promise<{ detachedImageKeys: string[] }> {
  const resolve = (codes: readonly string[]) =>
    options?.unresolved === "throw"
      ? resolveAllOrThrow(tx, "image", codes)
      : resolveAllPresent(tx, "image", codes);

  let detachedImageKeys: string[] = [];

  if (data.imageOrder?.length) {
    const orderedIds = await resolve(data.imageOrder);
    await applyImageOrder(tx, binding, parentId, orderedIds);
  }
  if (data.removeImageIds?.length) {
    const idsToRemove = await resolve(data.removeImageIds);
    // `parseEntityRef` (a typed resolver, not an assertion) is what correlates
    // this generic `entity`/`parentId` pair into the properly branded ref
    // `detachImagesFromEntity` needs — `parentId` is already a validated brand
    // from the caller, so this is a re-derivation, not fresh validation.
    ({ deletedKeys: detachedImageKeys } = await detachImagesFromEntity(
      tx,
      parseEntityRef<AttachableImageEntity>(entity, parentId),
      idsToRemove,
    ));
  }
  if (data.pendingImageIds?.length) {
    const pendingIds = await resolve(data.pendingImageIds);
    const startSortOrder = await nextImageSortOrder(tx, binding, parentId);
    await associatePendingImages(
      tx,
      binding,
      parentId,
      pendingIds,
      startSortOrder,
    );
  }

  return { detachedImageKeys };
}
