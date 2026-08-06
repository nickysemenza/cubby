/**
 * Image repository — the single data-access boundary for the `image` entity and
 * its product / location / recipe / project / purchase association join
 * tables. The full set of incoming edges is declared once, in
 * `~/server/db/entity-incoming-edges.ts` (`INCOMING_EDGES.image`), and
 * cross-checked against schema.ts by entity-manifest-fk.unit.test.ts — that's
 * what stops a new join table from silently repeating the gap that broke
 * `PurchaseImage` (see `deleteImages` and `findCullablePendingImages` below).
 *
 * Public API (consumed by routers + services; keep these signatures stable):
 * - {@link imageList}                         — paginated/sorted/filtered list with entity associations
 * - {@link getImageById}                      — fetch one image with its entity association
 * - {@link updateImage}                       — rename an image (the one safely user-editable column)
 * - {@link markImageUploaded}                 — flip a PENDING row to UPLOADED once the R2 PUT succeeds
 * - {@link cullPendingImages}                 — delete stale unassociated PENDING rows and return their keys
 * - {@link countCullablePendingImages}        — how many rows that cull would remove
 * - {@link deleteImages}                      — hard-delete image rows (+ their associations) and return their keys
 * - {@link previewDeleteImages}                — what {@link deleteImages} would do, without doing it
 * - {@link associateImagesWithProduct}        — attach PENDING images to a product
 * - {@link associateImagesWithRecipe}         — attach PENDING images to a recipe
 *
 * Storage/network orchestration lives in image-storage.service.ts.
 */

import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import type { ProjectId, RecipeId } from "@cubby/schemas/identifiers";
import {
  unsafeLocationId,
  unsafeProductId,
  unsafeProjectId,
  unsafePurchaseId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type {
  AttachableImageEntity,
  ImageUpdateInput,
  ImageWithEntity,
} from "@cubby/schemas/image";
import {
  attachableImageEntityId,
  imageSortableFields,
} from "@cubby/schemas/image";
import type { PurchaseDocumentKind } from "@cubby/schemas/purchase";
import { and, asc, count, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { match } from "ts-pattern";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type {
  IncomingEdgeKey,
  IncomingEdgePolicy,
} from "~/server/db/entity-incoming-edges";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import {
  image,
  location,
  locationImage,
  product,
  productImage,
  project,
  projectImage,
  purchase,
  purchaseImage,
  recipe,
  recipeImage,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
import {
  associatePendingImages,
  auditDateWhereConditions,
  buildOrderBy,
  countWhere,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  isNotDeleted,
  nextImageSortOrder,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import {
  countByTarget,
  impact,
  present,
  sideEffect,
} from "~/server/repo/impact";

export const createPendingImageRecord = async (
  db: Database,
  {
    key,
    url,
    filename,
    contentType,
    size,
  }: {
    key: string;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  },
) => {
  return await insertAndReturn(db, image, {
    key,
    filename,
    size,
    contentType,
    url,
    status: "PENDING",
  });
};

export const createUploadedImageRecord = async (
  db: Database | DrizzleTransaction,
  params: {
    key: string;
    url: string;
    filename: string;
    contentType: string;
    size: number;
    width?: number | null;
    height?: number | null;
    detectedContentType?: string | null;
    sha256?: string | null;
    renderStatus?: "unverified" | "verified" | "failed" | null;
    storageStatus?:
      | "unverified"
      | "available"
      | "missing"
      | "metadata_mismatch"
      | null;
    verifiedAt?: Date | null;
    targetType?: string | null;
    targetId?: string | null;
    idempotencyKey?: string | null;
  },
) => {
  return await insertAndReturn(db, image, {
    ...params,
    status: "UPLOADED",
  });
};

const imageIntegrityFields = (imageData: typeof image.$inferSelect) => ({
  width: imageData.width,
  height: imageData.height,
  detectedContentType: imageData.detectedContentType,
  sha256: imageData.sha256,
  renderStatus: imageData.renderStatus,
  storageStatus: imageData.storageStatus,
  verifiedAt: imageData.verifiedAt,
});

// Type for image with pre-loaded entity relations
// Note: Association deletedAt is filtered at query time, but we still need to check entity deletedAt
type ImageWithRelations = typeof image.$inferSelect & {
  productImages: Array<{
    productId: string;
    product: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  locationImages: Array<{
    locationId: string;
    location: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  recipeImages: Array<{
    recipeId: string;
    recipe: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  projectImages: Array<{
    projectId: string;
    project: { name: string; shortcode: string; deletedAt: Date | null };
  }>;
  purchaseImages: Array<{
    purchaseId: string;
    // Purchase has no `name` column (see purchase-label.ts); its vendor identity
    // and optional human context stay separate.
    purchase: {
      orderId: string | null;
      displayLabel: string | null;
      shortcode: string;
      deletedAt: Date | null;
    };
  }>;
};

/**
 * Transform image with pre-loaded relations to API format.
 * Expects relations to be loaded via `with` clause - no additional queries.
 * Note: Soft-deleted join table records filtered at query time, but we still check entity deletedAt.
 */
const imageWithRelationsToAPI = (
  imageData: ImageWithRelations,
): ImageWithEntity => {
  // Check product associations (join table filtered, but still check entity)
  const productAssoc = imageData.productImages.find((assoc) =>
    isNotDeleted(assoc.product),
  );
  if (productAssoc) {
    return {
      id: imageData.id,
      url: imageData.url,
      key: imageData.key,
      filename: imageData.filename,
      size: imageData.size,
      contentType: imageData.contentType,
      status: imageData.status,
      ...imageIntegrityFields(imageData),
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "PRODUCT",
      entityId: attachableImageEntityId.parse(productAssoc.product.shortcode),
      entityName: productAssoc.product.name,
    };
  }

  // Check location associations (join table filtered, but still check entity)
  const locationAssoc = imageData.locationImages.find((assoc) =>
    isNotDeleted(assoc.location),
  );
  if (locationAssoc) {
    return {
      id: imageData.id,
      url: imageData.url,
      key: imageData.key,
      filename: imageData.filename,
      size: imageData.size,
      contentType: imageData.contentType,
      status: imageData.status,
      ...imageIntegrityFields(imageData),
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "LOCATION",
      entityId: attachableImageEntityId.parse(locationAssoc.location.shortcode),
      entityName: locationAssoc.location.name,
    };
  }

  // Check recipe associations (join table filtered, but still check entity)
  const recipeAssoc = imageData.recipeImages.find((assoc) =>
    isNotDeleted(assoc.recipe),
  );
  if (recipeAssoc) {
    return {
      id: imageData.id,
      url: imageData.url,
      key: imageData.key,
      filename: imageData.filename,
      size: imageData.size,
      contentType: imageData.contentType,
      status: imageData.status,
      ...imageIntegrityFields(imageData),
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "RECIPE",
      entityId: attachableImageEntityId.parse(recipeAssoc.recipe.shortcode),
      entityName: recipeAssoc.recipe.name,
    };
  }

  // Check project associations (join table filtered, but still check entity)
  const projectAssoc = imageData.projectImages.find((assoc) =>
    isNotDeleted(assoc.project),
  );
  if (projectAssoc) {
    return {
      id: imageData.id,
      url: imageData.url,
      key: imageData.key,
      filename: imageData.filename,
      size: imageData.size,
      contentType: imageData.contentType,
      status: imageData.status,
      ...imageIntegrityFields(imageData),
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "PROJECT",
      entityId: attachableImageEntityId.parse(projectAssoc.project.shortcode),
      entityName: projectAssoc.project.name,
    };
  }

  // Check Purchase associations (vendor documents — join table filtered,
  // but still check entity). No `notDeleted(purchase)` guard is needed beyond
  // that: `deletePurchases` refuses while live expenses reference the Purchase,
  // unlike the four entities above whose deletion always leaves images behind.
  const purchaseAssoc = imageData.purchaseImages.find((assoc) =>
    isNotDeleted(assoc.purchase),
  );
  if (purchaseAssoc) {
    return {
      id: imageData.id,
      url: imageData.url,
      key: imageData.key,
      filename: imageData.filename,
      size: imageData.size,
      contentType: imageData.contentType,
      status: imageData.status,
      ...imageIntegrityFields(imageData),
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "PURCHASE",
      entityId: attachableImageEntityId.parse(purchaseAssoc.purchase.shortcode),
      entityName: purchaseAssoc.purchase.orderId
        ? purchaseAssoc.purchase.displayLabel?.trim()
          ? `${purchaseAssoc.purchase.orderId} (${purchaseAssoc.purchase.displayLabel.trim()})`
          : purchaseAssoc.purchase.orderId
        : purchaseAssoc.purchase.displayLabel,
    };
  }

  // No entity association found
  return {
    id: imageData.id,
    url: imageData.url,
    key: imageData.key,
    filename: imageData.filename,
    size: imageData.size,
    contentType: imageData.contentType,
    status: imageData.status,
    ...imageIntegrityFields(imageData),
    createdAt: imageData.createdAt,
    updatedAt: imageData.updatedAt,
    entityType: null,
    entityId: null,
    entityName: null,
  };
};

/** Shared relation config for loading entity associations with soft-delete filtering */
const imageEntityRelations = {
  productImages: {
    where: notDeleted(productImage),
    with: {
      product: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { productId: true },
  },
  locationImages: {
    where: notDeleted(locationImage),
    with: {
      location: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { locationId: true },
  },
  recipeImages: {
    where: notDeleted(recipeImage),
    with: {
      recipe: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { recipeId: true },
  },
  projectImages: {
    where: notDeleted(projectImage),
    with: {
      project: {
        columns: { name: true, shortcode: true, deletedAt: true },
      },
    },
    columns: { projectId: true },
  },
  purchaseImages: {
    where: notDeleted(purchaseImage),
    with: {
      purchase: {
        columns: {
          orderId: true,
          displayLabel: true,
          shortcode: true,
          deletedAt: true,
        },
      },
    },
    columns: { purchaseId: true },
  },
} as const;

export const imageList = async (
  db: Database,
  filters: import("@cubby/schemas/image").ImageListFilters,
  sorts: Array<{ orderBy: string; direction: "asc" | "desc" }>,
  pagination: { pageIndex: number; pageSize: number },
) => {
  const dbClient = getDb(db);

  const whereConditions: ReturnType<typeof eq>[] = [];
  const filenameCondition = formatSearchTerm(
    image.filename,
    filters.nameFilter,
  );
  if (filenameCondition) {
    whereConditions.push(filenameCondition);
  }
  whereConditions.push(
    ...auditDateWhereConditions(image, filters).filter(
      (condition): condition is NonNullable<typeof condition> =>
        Boolean(condition),
    ),
  );

  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  const orderByClause = buildOrderBy(image, sorts, [...imageSortableFields]);

  const take = pagination.pageSize;
  const skip = pagination.pageIndex * pagination.pageSize;

  const { data: images, count } = await executeListQueryWithCount(
    dbClient.query.image.findMany({
      where: whereClause,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
      with: imageEntityRelations,
    }),
    countWhere(db, image, whereClause),
  );

  const processedImages = images.map(imageWithRelationsToAPI);

  return {
    data: processedImages,
    count,
  };
};

export const getImageById = async (
  db: Database,
  imageId: string,
): Promise<ImageWithEntity> => {
  const imageRecord = await getDb(db).query.image.findFirst({
    where: eq(image.id, imageId),
    with: imageEntityRelations,
  });

  if (!imageRecord) {
    throw createAppError("IMAGE_NOT_FOUND", "Image not found");
  }

  return imageWithRelationsToAPI(imageRecord);
};

/**
 * Rename an image. `filename` is the only safely user-editable column — `key`/
 * `url`/`size`/`contentType`/`status` are all derived from the upload itself,
 * so this is intentionally the entire update surface (see `imageUpdateInput`).
 * Re-reads via {@link getImageById} so the output matches `getByID`'s shape
 * (including the resolved entity association) rather than a bare row.
 */
export const updateImage = async (
  db: Database,
  imageId: string,
  data: ImageUpdateInput,
): Promise<ImageWithEntity> => {
  await updateAndReturn(
    db,
    image,
    { filename: data.filename },
    and(eq(image.id, imageId), notDeleted(image)),
  );
  return getImageById(db, imageId);
};

/**
 * Flip a PENDING image row to UPLOADED once the browser's presigned PUT to R2
 * succeeds. Without this, a standalone `/images` upload (no owning entity to
 * call `associatePendingImages`) stays PENDING forever — rendering "Upload
 * pending…" indefinitely and then getting deleted, R2 object included, by
 * {@link findCullablePendingImages} (PENDING + no association is exactly its
 * selection).
 *
 * Predicated on `status = "PENDING"` (not just `id`) so the transition is
 * forward-only and safe: it can never resurrect a FAILED row back to
 * UPLOADED, and a duplicate call on a row that already flipped throws rather
 * than silently re-writing state that something else may have changed since.
 */
export const markImageUploaded = async (
  db: Database,
  imageId: string,
): Promise<ImageWithEntity> => {
  await updateAndReturn(
    db,
    image,
    { status: "UPLOADED" },
    and(eq(image.id, imageId), eq(image.status, "PENDING"), notDeleted(image)),
  );
  return getImageById(db, imageId);
};

export const getImageByKey = async (
  db: Database,
  key: string,
): Promise<{ id: string; url: string; key: string } | null> => {
  const imageRecord = await getDb(db).query.image.findFirst({
    where: eq(image.key, key),
    columns: {
      id: true,
      url: true,
      key: true,
    },
  });

  return imageRecord ?? null;
};

/**
 * Unassociated PENDING image rows older than the threshold — the abandoned
 * uploads the cull deletes. Shared by {@link cullPendingImages} and
 * {@link countCullablePendingImages} so the Maintenance card's "N affected"
 * figure can't drift from what the button actually removes.
 */
const findCullablePendingImages = async (
  db: Database,
  olderThanHours: number,
): Promise<Array<{ id: string; key: string }>> => {
  const dbClient = getDb(db);

  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);

  // Every incoming edge on `image` (INCOMING_EDGES.image), checked uniformly
  // in one loop. `isNotNull` is harmlessly always-true on the five join
  // tables' NOT NULL `imageId` column and does the real work on the one direct
  // FK (`Cookbook.coverImageId`) — a cookbook cover is a DIRECT FK, not a join
  // row, so enumerating only join tables would miss it, and this feeds a HARD
  // delete wired to the one-click auto-fix. `deleteImages` below handles the
  // same edge set (via `IMAGE_HARD_DELETE`, keyed off this same map), so a new
  // edge added to one but not the other — the asymmetry that broke
  // `PurchaseImage` originally — is no longer possible: both read from
  // `INCOMING_EDGES.image`.
  //
  // Deliberately NOT filtered by `notDeleted(...)`: e.g. deleteCookbook
  // tombstones the row without nulling coverImageId, so a soft-deleted cookbook
  // still holds a live FK. The constraint doesn't care about deletedAt, and this
  // cull is a hard delete — filtering here would cull exactly the images that
  // then blow up on the FK constraint when the hard delete runs.
  const associationQueries = Object.values(INCOMING_EDGES.image).map(
    ({ column }) =>
      dbClient
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for select()
        .select({ imageId: column as any })
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for from()
        .from(column.table as any)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for isNotNull()
        .where(isNotNull(column as any)) as Promise<Array<{ imageId: string }>>,
  );
  const associationResults = await Promise.all(associationQueries);
  const associatedImageIds = new Set(
    associationResults.flatMap((rows) => rows.map((row) => row.imageId)),
  );

  const allPendingImages = await dbClient.query.image.findMany({
    where: and(eq(image.status, "PENDING"), lt(image.createdAt, cutoffDate)),
    columns: {
      id: true,
      key: true,
    },
  });

  return allPendingImages.filter((img) => !associatedImageIds.has(img.id));
};

/** How many abandoned uploads the cull would remove right now. */
export const countCullablePendingImages = async (
  db: Database,
  olderThanHours: number,
): Promise<number> =>
  (await findCullablePendingImages(db, olderThanHours)).length;

export const cullPendingImages = async (
  db: Database,
  olderThanHours: number,
) => {
  const pendingImages = await findCullablePendingImages(db, olderThanHours);

  if (pendingImages.length === 0) {
    return { count: 0, deletedIds: [], deletedKeys: [] };
  }

  const imageIds = pendingImages.map((img) => img.id);
  const imageKeys = pendingImages.map((img) => img.key);

  await getDb(db).delete(image).where(inArray(image.id, imageIds));

  return {
    count: pendingImages.length,
    deletedIds: imageIds,
    deletedKeys: imageKeys,
  };
};

/**
 * How to clear each of `image`'s incoming edges (`INCOMING_EDGES.image`)
 * before the hard delete below. `Record` over that literal-union key type
 * requires every declared edge to have an entry, so a new edge on `image` is a
 * compile error here until it's dispositioned — the guard that would have
 * caught `PurchaseImage` shipping with no disposition in the first place.
 *
 * - `hard-delete` (`deleteRow`) — a join table: delete the association row,
 *   detaching the image from whatever product/location/recipe/project/purchase
 *   owned it.
 * - `detach` (`clearFk`) — a direct FK column (`Cookbook.coverImageId` today):
 *   null it so the parent row survives, just without a cover.
 */
export const IMAGE_HARD_DELETE = {
  "Cookbook.coverImageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "A cookbook's cover image is cleared, not cascaded — the cookbook survives without a cover.",
  },
  "ProductImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The product's image association is removed along with the image.",
  },
  "LocationImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The location's image association is removed along with the image.",
  },
  "RecipeImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The recipe's image association is removed along with the image.",
  },
  "ProjectImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The project's image association is removed along with the image.",
  },
  "PurchaseImage.imageId": {
    code: "deleteRow",
    effect: "hard-delete",
    description:
      "The purchase's image association is removed along with the image.",
  },
} satisfies IncomingEdgePolicy<"image", OperationDisposition>;

/**
 * Resolve `imageIds` down to the subset that actually exists — bogus or
 * already-gone ids are silently skipped rather than causing a partial
 * cascade. Shared by {@link deleteImages} (which also needs the keys, for the
 * R2 cleanup) and {@link previewDeleteImages} (which only needs the ids), so
 * both start the cascade from the exact same set.
 */
const fetchExistingImages = (
  dbc: DrizzleClient | DrizzleTransaction,
  imageIds: string[],
): Promise<Array<{ id: string; key: string }>> =>
  dbc.query.image.findMany({
    where: inArray(image.id, imageIds),
    columns: { id: true, key: true },
  });

/**
 * Hard-delete image rows and return their R2 keys so the caller can drop the
 * objects too.
 *
 * `Image` DOES carry a `deletedAt` (see `softDeletedAt()` in schema.ts, and the
 * partial unique index on `key` that keys off it) — it's simply never set,
 * because images are the one gallery entity deleted for real rather than
 * tombstoned. An image with no owning entity has no use once removed, and
 * restore was never implemented for any entity, so "delete" here means the row
 * is gone — matching how the pending cull already works. Reads still go through
 * `notDeleted(image)` so the column stays honest if that ever changes.
 * Every incoming edge is cleared first, per {@link IMAGE_HARD_DELETE}'s
 * disposition — they FK the image, so this also detaches it from whatever
 * entity owned it. Missing ids are skipped; the returned keys are only those
 * actually removed.
 */
export const deleteImages = async (
  db: Database,
  imageIds: string[],
): Promise<{ deletedIds: string[]; deletedKeys: string[] }> => {
  if (imageIds.length === 0) return { deletedIds: [], deletedKeys: [] };

  return await withTransaction(db, async (tx) => {
    const rows = await fetchExistingImages(tx, imageIds);
    if (rows.length === 0) return { deletedIds: [], deletedKeys: [] };

    const ids = rows.map((row) => row.id);
    const affectedPurchases = await tx
      .selectDistinct({ purchaseId: purchaseImage.purchaseId })
      .from(purchaseImage)
      .where(
        and(inArray(purchaseImage.imageId, ids), notDeleted(purchaseImage)),
      );

    for (const [key, disposition] of Object.entries(IMAGE_HARD_DELETE)) {
      const { column } = INCOMING_EDGES.image[key as IncomingEdgeKey<"image">];
      if (disposition.effect === "hard-delete") {
        await tx
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for delete()
          .delete(column.table as any)
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for inArray()
          .where(inArray(column as any, ids));
      } else {
        await tx
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for update()
          .update(column.table as any)
          .set({ [column.name]: null })
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for inArray()
          .where(inArray(column as any, ids));
      }
    }

    await tx.delete(image).where(inArray(image.id, ids));

    await touchDataQualityTargets(tx, {
      purchaseIds: affectedPurchases.map((row) => row.purchaseId),
    });

    return { deletedIds: ids, deletedKeys: rows.map((row) => row.key) };
  });
};

/** Human-readable labels for each {@link IMAGE_HARD_DELETE} edge, for the preview. */
const IMAGE_HARD_DELETE_LABELS: Record<IncomingEdgeKey<"image">, string> = {
  "Cookbook.coverImageId": "cookbook cover references",
  "ProductImage.imageId": "product image associations",
  "LocationImage.imageId": "location image associations",
  "RecipeImage.imageId": "recipe image associations",
  "ProjectImage.imageId": "project image associations",
  "PurchaseImage.imageId": "purchase image associations",
};

/**
 * What `deleteImages` would do to the given images, without doing it.
 *
 * Walks the SAME `IMAGE_HARD_DELETE` map, keyed off the SAME
 * `INCOMING_EDGES.image` columns and starting from the SAME
 * `fetchExistingImages` set, in the same shape `deleteImages` iterates it in
 * — a new edge added there shows up here with no second change.
 *
 * Every count is taken WITHOUT a `notDeleted` filter on the referencing row,
 * matching `deleteImages` itself: a soft-deleted parent (e.g. a tombstoned
 * cookbook) can still hold a live FK to the image — see the "Deliberately NOT
 * filtered" comment on `findCullablePendingImages` above — and that row
 * really is cleared/removed by the hard delete, so filtering it out here
 * would under-report. There are no blockers: a hard image delete is never
 * refused, only performed.
 *
 * Advisory only. `deleteImages` re-runs the same walk inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteImages = async (
  db: Database,
  ids: string[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects?: ImpactItem[];
}> => {
  if (ids.length === 0) return { blockers: [], changes: [] };

  const dbClient = getDb(db);

  const existingImages = await fetchExistingImages(dbClient, ids);
  if (existingImages.length === 0) return { blockers: [], changes: [] };
  const existingIds = existingImages.map((row) => row.id);

  const changes: (ImpactItem | null)[] = [];
  for (const [key, disposition] of Object.entries(IMAGE_HARD_DELETE)) {
    const edgeKey = key as IncomingEdgeKey<"image">;
    const { column } = INCOMING_EDGES.image[edgeKey];
    changes.push(
      impact({
        disposition,
        edgeKey,
        label: IMAGE_HARD_DELETE_LABELS[edgeKey],
        byTargetId: await countByTarget(
          dbClient,
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for countByTarget's table param
          column.table as any,
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for countByTarget's column param
          column as any,
          existingIds,
          { includeDeleted: true },
        ),
      }),
    );
  }

  const byExistingId: Record<string, number> = Object.fromEntries(
    existingIds.map((id) => [id, 1]),
  );

  return {
    blockers: [],
    changes: present(changes),
    sideEffects: [
      sideEffect({
        code: "r2-object-removed",
        label: "R2 storage object",
        description:
          "The underlying file in R2 storage is removed along with the row — this is the one hard delete in the system and is not recoverable.",
        effect: "hard-delete",
        total: existingIds.length,
        byTargetId: byExistingId,
      }),
    ],
  };
};

/**
 * Associate an image with a product.
 *
 * @param db Database client
 * @param productId Product ID to associate the image with
 * @param imageIds Array of image IDs to associate
 */
export const associateImagesWithProduct = async (
  db: Database,
  productId: string,
  imageIds: string[],
): Promise<void> => {
  await associatePendingImages(
    getDb(db),
    productImage,
    "productId",
    productId,
    imageIds,
  );
};

/**
 * Associate an image with a recipe. The recipe counterpart of
 * {@link associateImagesWithProduct} (server-side scrape import — see
 * `importRecipeImageFromUrl`).
 */
export const associateImagesWithRecipe = async (
  db: Database,
  recipeId: RecipeId,
  imageIds: string[],
): Promise<void> => {
  await associatePendingImages(
    getDb(db),
    recipeImage,
    "recipeId",
    recipeId,
    imageIds,
  );
};

/**
 * Does this recipe already have a (non-deleted) image attached? Guards the
 * server-side import from re-fetching a hero photo into R2 on every re-import
 * (`Image` has no source-URL column to dedupe on).
 */
export const recipeHasImages = async (
  db: Database,
  recipeId: RecipeId,
): Promise<boolean> => {
  const count = await countWhere(
    db,
    recipeImage,
    and(eq(recipeImage.recipeId, recipeId), notDeleted(recipeImage)),
  );
  return count > 0;
};

/**
 * Assert an attach target exists (and isn't soft-deleted) before we upload +
 * associate, so a bad id fails cleanly instead of surfacing as a raw FK
 * violation after the object is already in R2.
 */
export const assertAttachableEntityExists = async (
  db: Database,
  entityType: AttachableImageEntity,
  entityId: string,
): Promise<void> => {
  // Count inside each arm so the table is a concrete type — a union of the four
  // (branded-id) tables collapses Drizzle's query inference to `never`.
  const count = await match(entityType)
    .with("product", () =>
      countWhere(
        db,
        product,
        and(eq(product.id, unsafeProductId(entityId)), notDeleted(product)),
      ),
    )
    .with("recipe", () =>
      countWhere(
        db,
        recipe,
        and(eq(recipe.id, unsafeRecipeId(entityId)), notDeleted(recipe)),
      ),
    )
    .with("location", () =>
      countWhere(
        db,
        location,
        and(eq(location.id, unsafeLocationId(entityId)), notDeleted(location)),
      ),
    )
    .with("project", () =>
      countWhere(
        db,
        project,
        and(eq(project.id, unsafeProjectId(entityId)), notDeleted(project)),
      ),
    )
    .with("purchase", () =>
      countWhere(
        db,
        purchase,
        and(eq(purchase.id, unsafePurchaseId(entityId)), notDeleted(purchase)),
      ),
    )
    .exhaustive();
  if (count === 0) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${entityType} ${entityId} not found`,
    );
  }
};

/** Locate a previous MCP attachment retry without treating arbitrary Image rows
 * as idempotency winners. */
export const findAttachmentByIdempotencyKey = async (
  db: Database | DrizzleTransaction,
  entityType: AttachableImageEntity,
  entityId: string,
  idempotencyKey: string,
): Promise<typeof image.$inferSelect | null> =>
  (await ("query" in db ? db : getDb(db)).query.image.findFirst({
    where: and(
      eq(image.targetType, entityType),
      eq(image.targetId, entityId),
      eq(image.idempotencyKey, idempotencyKey),
      notDeleted(image),
    ),
  })) ?? null;

export const getImagesAttachedToEntity = async (
  db: Database,
  entityType: AttachableImageEntity,
  entityId: string,
): Promise<Array<typeof image.$inferSelect>> => {
  const dbc = getDb(db);
  return await match(entityType)
    .with("product", () =>
      dbc
        .select({ image })
        .from(productImage)
        .innerJoin(image, eq(productImage.imageId, image.id))
        .where(
          and(
            eq(productImage.productId, unsafeProductId(entityId)),
            notDeleted(productImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with("recipe", () =>
      dbc
        .select({ image })
        .from(recipeImage)
        .innerJoin(image, eq(recipeImage.imageId, image.id))
        .where(
          and(
            eq(recipeImage.recipeId, unsafeRecipeId(entityId)),
            notDeleted(recipeImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with("location", () =>
      dbc
        .select({ image })
        .from(locationImage)
        .innerJoin(image, eq(locationImage.imageId, image.id))
        .where(
          and(
            eq(locationImage.locationId, unsafeLocationId(entityId)),
            notDeleted(locationImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with("project", () =>
      dbc
        .select({ image })
        .from(projectImage)
        .innerJoin(image, eq(projectImage.imageId, image.id))
        .where(
          and(
            eq(projectImage.projectId, unsafeProjectId(entityId)),
            notDeleted(projectImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .with("purchase", () =>
      dbc
        .select({ image })
        .from(purchaseImage)
        .innerJoin(image, eq(purchaseImage.imageId, image.id))
        .where(
          and(
            eq(purchaseImage.purchaseId, unsafePurchaseId(entityId)),
            notDeleted(purchaseImage),
            notDeleted(image),
          ),
        )
        .then((rows) => rows.map((row) => row.image)),
    )
    .exhaustive();
};

export const updateImageIntegrity = async (
  db: Database,
  imageId: string,
  values: Pick<
    typeof image.$inferInsert,
    | "width"
    | "height"
    | "detectedContentType"
    | "sha256"
    | "renderStatus"
    | "storageStatus"
    | "verifiedAt"
  >,
): Promise<void> => {
  await getDb(db)
    .update(image)
    .set(values)
    .where(and(eq(image.id, imageId), notDeleted(image)));
};

const lockAttachableEntity = async (
  tx: DrizzleTransaction,
  entityType: AttachableImageEntity,
  entityId: string,
): Promise<void> => {
  const rows = await match(entityType)
    .with("product", () =>
      tx
        .select({ id: product.id })
        .from(product)
        .where(
          and(eq(product.id, unsafeProductId(entityId)), notDeleted(product)),
        )
        .for("update"),
    )
    .with("recipe", () =>
      tx
        .select({ id: recipe.id })
        .from(recipe)
        .where(and(eq(recipe.id, unsafeRecipeId(entityId)), notDeleted(recipe)))
        .for("update"),
    )
    .with("location", () =>
      tx
        .select({ id: location.id })
        .from(location)
        .where(
          and(
            eq(location.id, unsafeLocationId(entityId)),
            notDeleted(location),
          ),
        )
        .for("update"),
    )
    .with("project", () =>
      tx
        .select({ id: project.id })
        .from(project)
        .where(
          and(eq(project.id, unsafeProjectId(entityId)), notDeleted(project)),
        )
        .for("update"),
    )
    .with("purchase", () =>
      tx
        .select({ id: purchase.id })
        .from(purchase)
        .where(
          and(
            eq(purchase.id, unsafePurchaseId(entityId)),
            notDeleted(purchase),
          ),
        )
        .for("update"),
    )
    .exhaustive();
  if (rows.length === 0) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${entityType} ${entityId} not found`,
    );
  }
};

const countDisplayableAttachedImages = async (
  tx: DrizzleTransaction,
  entityType: AttachableImageEntity,
  entityId: string,
): Promise<number> => {
  const whereImage = and(notDeleted(image), displayableImageWhere);
  const totals = await match(entityType)
    .with("product", () =>
      tx
        .select({ total: count() })
        .from(productImage)
        .innerJoin(image, eq(productImage.imageId, image.id))
        .where(
          and(
            eq(productImage.productId, unsafeProductId(entityId)),
            notDeleted(productImage),
            whereImage,
          ),
        ),
    )
    .with("recipe", () =>
      tx
        .select({ total: count() })
        .from(recipeImage)
        .innerJoin(image, eq(recipeImage.imageId, image.id))
        .where(
          and(
            eq(recipeImage.recipeId, unsafeRecipeId(entityId)),
            notDeleted(recipeImage),
            whereImage,
          ),
        ),
    )
    .with("location", () =>
      tx
        .select({ total: count() })
        .from(locationImage)
        .innerJoin(image, eq(locationImage.imageId, image.id))
        .where(
          and(
            eq(locationImage.locationId, unsafeLocationId(entityId)),
            notDeleted(locationImage),
            whereImage,
          ),
        ),
    )
    .with("project", () =>
      tx
        .select({ total: count() })
        .from(projectImage)
        .innerJoin(image, eq(projectImage.imageId, image.id))
        .where(
          and(
            eq(projectImage.projectId, unsafeProjectId(entityId)),
            notDeleted(projectImage),
            whereImage,
          ),
        ),
    )
    .with("purchase", () =>
      tx
        .select({ total: count() })
        .from(purchaseImage)
        .innerJoin(image, eq(purchaseImage.imageId, image.id))
        .where(
          and(
            eq(purchaseImage.purchaseId, unsafePurchaseId(entityId)),
            notDeleted(purchaseImage),
            whereImage,
          ),
        ),
    )
    .exhaustive();
  return Number(totals[0]?.total ?? 0);
};

/**
 * Attach an already-UPLOADED image to one of the four gallery entities by
 * dispatching to its join table. Mirrors {@link associateImagesWithProduct} for
 * the other three; `.exhaustive()` forces this to grow if `attachableImageEntity`
 * does. Takes a client-or-tx so it can run inside the insert transaction (see
 * {@link createAndAssociateUploadedImage}).
 */
const associateImageWithEntity = async (
  dbc: DrizzleClient | DrizzleTransaction,
  entityType: AttachableImageEntity,
  entityId: string,
  imageId: string,
  documentKind?: PurchaseDocumentKind,
): Promise<void> => {
  await match(entityType)
    .with("product", () =>
      associatePendingImages(dbc, productImage, "productId", entityId, [
        imageId,
      ]),
    )
    .with("recipe", () =>
      associatePendingImages(dbc, recipeImage, "recipeId", entityId, [imageId]),
    )
    .with("location", () =>
      associatePendingImages(dbc, locationImage, "locationId", entityId, [
        imageId,
      ]),
    )
    .with("project", () =>
      associatePendingImages(dbc, projectImage, "projectId", entityId, [
        imageId,
      ]),
    )
    .with("purchase", async () => {
      const sortOrder = await nextImageSortOrder(
        dbc,
        purchaseImage,
        purchaseImage.purchaseId,
        entityId,
      );
      await dbc.insert(purchaseImage).values({
        purchaseId: unsafePurchaseId(entityId),
        imageId,
        sortOrder,
        documentKind: documentKind ?? "other",
      });
      await dbc
        .update(purchase)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(purchase.id, unsafePurchaseId(entityId)),
            notDeleted(purchase),
          ),
        );
    })
    .exhaustive();
};

/**
 * Insert an UPLOADED image row and associate it with its target entity in a
 * single transaction, so a failure in either step rolls back the DB write. The
 * caller owns removing the R2 object on failure (see attachFileToEntity) — a
 * stranded UPLOADED row would otherwise never be reaped (cull only touches
 * PENDING rows).
 */
export const createAndAssociateUploadedImage = async (
  db: Database,
  params: {
    key: string;
    url: string;
    filename: string;
    contentType: string;
    size: number;
    width?: number | null;
    height?: number | null;
    detectedContentType?: string | null;
    sha256?: string | null;
    renderStatus?: "unverified" | "verified" | "failed" | null;
    storageStatus?:
      | "unverified"
      | "available"
      | "missing"
      | "metadata_mismatch"
      | null;
    verifiedAt?: Date | null;
    targetType?: string | null;
    targetId?: string | null;
    idempotencyKey?: string | null;
  },
  entityType: AttachableImageEntity,
  entityId: string,
  documentKind?: PurchaseDocumentKind,
): Promise<typeof image.$inferSelect> => {
  return (
    await createOrReuseAttachedImage(
      db,
      params,
      entityType,
      entityId,
      documentKind,
    )
  ).row;
};

/**
 * Transactional half of MCP attachment. The target row lock makes the gallery
 * count precondition meaningful, while the partial unique index elects one
 * winner if two requests with the same idempotency key race after uploading.
 */
export const createOrReuseAttachedImage = async (
  db: Database,
  params: Parameters<typeof createUploadedImageRecord>[1] & {
    expectedImageCount?: number;
  },
  entityType: AttachableImageEntity,
  entityId: string,
  documentKind?: PurchaseDocumentKind,
): Promise<{ row: typeof image.$inferSelect; reused: boolean }> =>
  await withTransaction(db, async (tx) => {
    await lockAttachableEntity(tx, entityType, entityId);
    if (params.idempotencyKey) {
      const winner = await findAttachmentByIdempotencyKey(
        tx,
        entityType,
        entityId,
        params.idempotencyKey,
      );
      if (winner) return { row: winner, reused: true };
    }
    if (params.expectedImageCount !== undefined) {
      const actual = await countDisplayableAttachedImages(
        tx,
        entityType,
        entityId,
      );
      if (actual !== params.expectedImageCount) {
        throw createAppError(
          "IMAGE_PRECONDITION_FAILED",
          `Expected ${params.expectedImageCount} displayable images, found ${actual}`,
        );
      }
    }

    const { expectedImageCount: _expectedImageCount, ...record } = params;
    const [inserted] = await tx
      .insert(image)
      .values({
        ...record,
        status: "UPLOADED",
        targetType: entityType,
        targetId: entityId,
      })
      .onConflictDoNothing({
        target: [image.targetType, image.targetId, image.idempotencyKey],
        where: sql`${image.idempotencyKey} IS NOT NULL AND ${image.deletedAt} IS NULL`,
      })
      .returning();
    if (!inserted) {
      // Only possible for an idempotency race; the target lock serializes the
      // normal expected-count path. Re-read so the loser can return the winner.
      if (params.idempotencyKey) {
        const winner = await findAttachmentByIdempotencyKey(
          tx,
          entityType,
          entityId,
          params.idempotencyKey,
        );
        if (winner) return { row: winner, reused: true };
      }
      throw new Error("Image attachment insert unexpectedly returned no row");
    }
    await associateImageWithEntity(
      tx,
      entityType,
      entityId,
      inserted.id,
      documentKind,
    );
    return { row: inserted, reused: false };
  });

/**
 * Fetch images for a set of projects, grouped by project id and ordered
 * cover-first (sortOrder, then createdAt). The forward-direction counterpart
 * of `imageEntityRelations.projectImages` above (which resolves image → owning
 * project for the generic image browser) — this resolves project → images,
 * for the projects dashboard (card covers) and the project detail page
 * (gallery). Projects have no dedicated repo module of their own to host this
 * (see apps/web/src/server/repo/project/), so it lives alongside the other
 * entity-image joins here.
 */
export const getImagesByProjectIds = async (
  db: Database,
  projectIds: ProjectId[],
): Promise<
  Record<string, Array<{ id: string; url: string; filename: string }>>
> => {
  if (projectIds.length === 0) return {};

  const rows = await getDb(db)
    .select({
      projectId: projectImage.projectId,
      id: image.id,
      url: image.url,
      filename: image.filename,
    })
    .from(projectImage)
    .innerJoin(image, eq(projectImage.imageId, image.id))
    .where(
      and(
        inArray(projectImage.projectId, projectIds),
        notDeleted(projectImage),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .orderBy(asc(projectImage.sortOrder), asc(projectImage.createdAt));

  const result: Record<
    string,
    Array<{ id: string; url: string; filename: string }>
  > = {};
  for (const row of rows) {
    const list = result[row.projectId] ?? [];
    list.push({
      id: row.id,
      url: row.url,
      filename: row.filename,
    });
    result[row.projectId] = list;
  }
  return result;
};
