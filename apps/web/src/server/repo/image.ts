/** Image data boundary: derive association and cascade behavior from INCOMING_EDGES.image. */

import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  EntityRef,
  ImageId,
  ImageShortcode,
  ProjectId,
  RecipeId,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  AttachableImageEntity,
  ImageAssociation,
  ImageListFilters,
  ImageUpdateInput,
  ImageWithEntity,
} from "@cubby/schemas/image";
import {
  attachableImageEntityId,
  imageSortableFields,
} from "@cubby/schemas/image";
import type { PurchaseDocumentKind } from "@cubby/schemas/purchase";
import {
  aliasedTable,
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { match } from "ts-pattern";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type {
  IncomingEdgeKey,
  IncomingEdgePolicy,
} from "~/server/db/entity-incoming-edges";
import { INCOMING_EDGES } from "~/server/db/entity-incoming-edges";
import {
  cookbook,
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
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
import {
  associatePendingImages,
  auditDateWhereConditions,
  buildOrderBy,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  isNotDeleted,
  type ListReadIntent,
  nextImageSortOrder,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import {
  generateUniqueShortcode,
  insertWithShortcode,
} from "~/server/repo/shortcode-utils";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

type AttachableImageRef = Extract<EntityRef, { entity: AttachableImageEntity }>;

export const createPendingImageRecord = async (
  db: Database,
  {
    key,
    filename,
    contentType,
    size,
  }: {
    key: string;
    filename: string;
    contentType: string;
    size: number;
  },
) => {
  // `insertWithShortcode`, not a bare insert: Image now carries a public `IMG-`
  // id, and minting is what turns a row into something addressable.
  return await insertWithShortcode(db, "image", {
    key,
    filename,
    size,
    contentType,
    status: "PENDING",
  });
};

export const createUploadedImageRecord = async (
  db: Database | DrizzleTransaction,
  params: {
    key: string;
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
  return await insertWithShortcode(db, "image", {
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
    purchase: {
      orderId: string | null;
      displayLabel: string | null;
      shortcode: string;
      deletedAt: Date | null;
    };
  }>;
  cookbookCovers: Array<{
    name: string;
    shortcode: string;
    deletedAt: Date | null;
  }>;
  vendorLogos: Array<{
    name: string;
    shortcode: string;
    deletedAt: Date | null;
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
  const associations: ImageAssociation[] = [
    ...imageData.productImages
      .filter(({ product }) => isNotDeleted(product))
      .map(({ product }) => ({
        entityType: "product" as const,
        entityId: product.shortcode,
        entityName: product.name,
        role: "attachment" as const,
      })),
    ...imageData.locationImages
      .filter(({ location }) => isNotDeleted(location))
      .map(({ location }) => ({
        entityType: "location" as const,
        entityId: location.shortcode,
        entityName: location.name,
        role: "attachment" as const,
      })),
    ...imageData.recipeImages
      .filter(({ recipe }) => isNotDeleted(recipe))
      .map(({ recipe }) => ({
        entityType: "recipe" as const,
        entityId: recipe.shortcode,
        entityName: recipe.name,
        role: "attachment" as const,
      })),
    ...imageData.projectImages
      .filter(({ project }) => isNotDeleted(project))
      .map(({ project }) => ({
        entityType: "project" as const,
        entityId: project.shortcode,
        entityName: project.name,
        role: "attachment" as const,
      })),
    ...imageData.purchaseImages
      .filter(({ purchase }) => isNotDeleted(purchase))
      .map(({ purchase }) => ({
        entityType: "purchase" as const,
        entityId: purchase.shortcode,
        entityName:
          (purchase.orderId
            ? purchase.displayLabel?.trim()
              ? `${purchase.orderId} (${purchase.displayLabel.trim()})`
              : purchase.orderId
            : purchase.displayLabel?.trim()) ?? purchase.shortcode,
        role: "attachment" as const,
      })),
    ...imageData.cookbookCovers.filter(isNotDeleted).map((book) => ({
      entityType: "cookbook" as const,
      entityId: book.shortcode,
      entityName: book.name,
      role: "cover" as const,
    })),
    ...imageData.vendorLogos.filter(isNotDeleted).map((logoVendor) => ({
      entityType: "vendor" as const,
      entityId: logoVendor.shortcode,
      entityName: logoVendor.name,
      role: "logo" as const,
    })),
  ];
  const legacyAssociation = associations.find(
    ({ entityType }) => entityType !== "cookbook" && entityType !== "vendor",
  );
  const legacyEntityType = legacyAssociation
    ? match(legacyAssociation.entityType)
        .with("product", () => "PRODUCT" as const)
        .with("location", () => "LOCATION" as const)
        .with("recipe", () => "RECIPE" as const)
        .with("project", () => "PROJECT" as const)
        .with("purchase", () => "PURCHASE" as const)
        .with("cookbook", "vendor", () => null)
        .exhaustive()
    : null;

  return {
    id: parseShortcodeFor("image", imageData.shortcode),
    url: getR2PublicUrl(imageData.key),
    key: imageData.key,
    filename: imageData.filename,
    size: imageData.size,
    contentType: imageData.contentType,
    status: imageData.status,
    ...imageIntegrityFields(imageData),
    createdAt: imageData.createdAt,
    updatedAt: imageData.updatedAt,
    entityType: legacyEntityType,
    entityId:
      legacyEntityType && legacyAssociation
        ? attachableImageEntityId.parse(legacyAssociation.entityId)
        : null,
    entityName: legacyAssociation?.entityName ?? null,
    associations: associations.sort(
      (a, b) =>
        a.entityType.localeCompare(b.entityType) ||
        a.entityName.localeCompare(b.entityName) ||
        a.entityId.localeCompare(b.entityId),
    ),
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
  cookbookCovers: {
    where: notDeleted(cookbook),
    columns: { name: true, shortcode: true, deletedAt: true },
  },
  vendorLogos: {
    where: notDeleted(vendor),
    columns: { name: true, shortcode: true, deletedAt: true },
  },
} as const;

type ImageReferenceLiveness = "active" | "any-fk";

/**
 * The SQL form of the exhaustive incoming-edge set used by image deletion.
 *
 * `active` answers whether an image still renders through a live join row;
 * direct foreign keys remain references even when their owner is tombstoned.
 * `any-fk` answers the stricter question required before hard-deleting a
 * PENDING image: a tombstoned join row still holds an FK that PostgreSQL will
 * enforce. Keeping the distinction here prevents the maintenance detectors
 * from materializing every edge merely to make the same decision in JavaScript.
 */
const imageReferenceCondition = (
  db: Database,
  outerImage: typeof image,
  liveness: ImageReferenceLiveness,
): SQL => {
  const dbc = getDb(db);
  const joinReferenceWhere = (imageId: PgColumn, activeWhere: SQL) =>
    and(
      eq(imageId, outerImage.id),
      liveness === "active" ? activeWhere : undefined,
    );
  const byEdge = {
    // includes-deleted: direct FKs remain live constraints after their parent
    // is tombstoned, so reference membership must match hard-delete safety.
    "Cookbook.coverImageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(cookbook)
        .where(eq(cookbook.coverImageId, outerImage.id)),
    ),
    // includes-deleted: same direct-FK rule as Cookbook.coverImageId above.
    "Vendor.logoImageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(vendor)
        .where(eq(vendor.logoImageId, outerImage.id)),
    ),
    "ProductImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(productImage)
        .where(
          joinReferenceWhere(productImage.imageId, notDeleted(productImage)),
        ),
    ),
    "LocationImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(locationImage)
        .where(
          joinReferenceWhere(locationImage.imageId, notDeleted(locationImage)),
        ),
    ),
    "RecipeImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(recipeImage)
        .where(
          joinReferenceWhere(recipeImage.imageId, notDeleted(recipeImage)),
        ),
    ),
    "ProjectImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(projectImage)
        .where(
          joinReferenceWhere(projectImage.imageId, notDeleted(projectImage)),
        ),
    ),
    "PurchaseImage.imageId": exists(
      dbc
        .select({ one: sql`1` })
        .from(purchaseImage)
        .where(
          joinReferenceWhere(purchaseImage.imageId, notDeleted(purchaseImage)),
        ),
    ),
  } satisfies Record<IncomingEdgeKey<"image">, SQL>;

  return or(...Object.values(byEdge))!;
};

const activeImageReferenceCondition = (
  db: Database,
  outerImage: typeof image,
) => imageReferenceCondition(db, outerImage, "active");

const anyForeignKeyImageReferenceCondition = (
  db: Database,
  outerImage: typeof image,
) => imageReferenceCondition(db, outerImage, "any-fk");

const cullablePendingImageWhere = (db: Database, cutoffDate: Date) =>
  and(
    eq(image.status, "PENDING"),
    lt(image.createdAt, cutoffDate),
    // Any reference, including a tombstoned join-row owner, protects this hard
    // delete. PostgreSQL still enforces that FK even though no page renders it.
    not(anyForeignKeyImageReferenceCondition(db, image)),
  );

export const imageList = async (
  db: Database,
  filters: ImageListFilters,
  sorts: Array<{ orderBy: string; direction: "asc" | "desc" }>,
  pagination: { pageIndex: number; pageSize: number },
  readIntent: ListReadIntent = "page",
) => {
  const dbClient = getDb(db);
  const buildWhere = (outerImage: typeof image) => {
    const whereConditions: SQL[] = [];
    const filenameCondition = formatSearchTerm(
      outerImage.filename,
      filters.nameFilter,
    );
    if (filenameCondition) whereConditions.push(filenameCondition);
    const statusCondition = eqAny(outerImage.status, filters.status);
    if (statusCondition) whereConditions.push(statusCondition);
    whereConditions.push(
      ...auditDateWhereConditions(outerImage, filters).filter(
        (condition): condition is NonNullable<typeof condition> =>
          Boolean(condition),
      ),
    );
    if (filters.referencePresenceFilter) {
      const referenced = activeImageReferenceCondition(db, outerImage);
      whereConditions.push(
        filters.referencePresenceFilter === "has"
          ? referenced
          : not(referenced),
      );
    }
    if (filters.uploadedAgeHoursMin !== undefined) {
      whereConditions.push(
        sql`${outerImage.createdAt} < now() - (${filters.uploadedAgeHoursMin} * interval '1 hour')`,
      );
    }
    return whereConditions.length > 0 ? and(...whereConditions) : undefined;
  };

  const whereClause = buildWhere(aliasedTable(image, "image"));
  const countWhereClause = buildWhere(image);

  const orderByClause = buildOrderBy(image, sorts, [...imageSortableFields]);

  const take = pagination.pageSize;
  const skip = pagination.pageIndex * pagination.pageSize;

  const { data: images, count } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      dbClient.query.image.findMany({
        where: whereClause,
        orderBy: orderByClause,
        limit: take,
        offset: skip,
        with: imageEntityRelations,
      }),
    count: () => countWhere(db, image, countWhereClause),
  });

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
): Promise<{
  id: string;
  shortcode: string;
  url: string;
  key: string;
} | null> => {
  const imageRecord = await getDb(db).query.image.findFirst({
    where: eq(image.key, key),
    columns: {
      id: true,
      // Selected because callers report the PUBLIC id back to a client.
      shortcode: true,
      key: true,
    },
  });

  return imageRecord
    ? { ...imageRecord, url: getR2PublicUrl(imageRecord.key) }
    : null;
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

  const pendingImages = await dbClient
    .select({
      id: image.id,
      key: image.key,
    })
    .from(image)
    .where(cullablePendingImageWhere(db, cutoffDate));

  return pendingImages;
};

export const countCullablePendingImages = async (
  db: Database,
  olderThanHours: number,
): Promise<number> => {
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);
  const [row] = await getDb(db)
    .select({ count: sql<number>`count(*)::int` })
    .from(image)
    .where(cullablePendingImageWhere(db, cutoffDate));
  return row?.count ?? 0;
};

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
  "Vendor.logoImageId": {
    code: "clearFk",
    effect: "detach",
    description:
      "A vendor logo is cleared when its Image is removed; the vendor keeps its monogram fallback.",
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
 * cascade. Used by {@link deleteImages}, which also needs the keys for the R2
 * cleanup.
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
  imageIds: ImageId[],
): Promise<{ deletedIds: string[]; deletedKeys: string[] }> => {
  if (imageIds.length === 0) return { deletedIds: [], deletedKeys: [] };
  return await withTransaction(db, (tx) => deleteImagesTx(tx, imageIds));
};

/**
 * The cascade + hard delete itself, on a caller-owned transaction. Extracted so
 * {@link detachImagesFromEntity} can run it inside the very transaction that
 * removed the join rows — splitting the two across transactions would leave
 * exactly the window this whole mechanism exists to close.
 *
 * Private on purpose: `deleteImages` keeps the public "I own a boundary"
 * promise (and its `db.transaction` span) that `withTransactionOn` would blur.
 */
const deleteImagesTx = async (
  tx: DrizzleTransaction,
  imageIds: string[],
): Promise<{ deletedIds: string[]; deletedKeys: string[] }> => {
  if (imageIds.length === 0) return { deletedIds: [], deletedKeys: [] };

  const rows = await fetchExistingImages(tx, imageIds);
  if (rows.length === 0) return { deletedIds: [], deletedKeys: [] };

  const ids = rows.map((row) => row.id);
  const affectedPurchases = await tx
    .selectDistinct({ purchaseId: purchaseImage.purchaseId })
    .from(purchaseImage)
    .where(and(inArray(purchaseImage.imageId, ids), notDeleted(purchaseImage)));

  for (const [key, disposition] of Object.entries(IMAGE_HARD_DELETE)) {
    const { column } = INCOMING_EDGES.image[key as IncomingEdgeKey<"image">];
    const edgeColumn = column as PgColumn;
    const edgeTable = column.table as PgTable;
    if (disposition.effect === "hard-delete") {
      await tx.delete(edgeTable).where(inArray(edgeColumn, ids));
    } else {
      await tx
        .update(edgeTable)
        .set({ [column.name]: null })
        .where(inArray(edgeColumn, ids));
    }
  }

  await tx.delete(image).where(inArray(image.id, ids));

  await touchDataQualityTargets(tx, {
    purchaseIds: affectedPurchases.map((row) => row.purchaseId),
  });

  return { deletedIds: ids, deletedKeys: rows.map((row) => row.key) };
};

/** Referenced-image detection shares the image edge registry so delete and detach cannot drift. */
const findReferencedImageIds = async (
  dbc: DrizzleClient | DrizzleTransaction,
  imageIds?: string[],
): Promise<Set<string>> => {
  const referenced = new Set<string>();
  // Sequential, not Promise.all: a pg transaction is a single connection, and
  // this runs inside the caller's.
  for (const [key, disposition] of Object.entries(IMAGE_HARD_DELETE)) {
    const { column } = INCOMING_EDGES.image[key as IncomingEdgeKey<"image">];
    const edgeColumn = column as PgColumn;
    const edgeTable = column.table as PgTable;
    const rows = (await dbc
      .select({ imageId: edgeColumn })
      .from(edgeTable)
      .where(
        and(
          isNotNull(edgeColumn),
          imageIds ? inArray(edgeColumn, imageIds) : undefined,
          disposition.effect === "hard-delete"
            ? // biome-ignore lint/suspicious/noExplicitAny: Drizzle's table type is too narrow for notDeleted()
              notDeleted(edgeTable as any)
            : undefined,
        ),
      )) as Array<{ imageId: string | null }>;
    for (const row of rows) {
      if (row.imageId) referenced.add(row.imageId);
    }
  }
  return referenced;
};

/** Detach joins and reap newly unreferenced uploaded images transactionally; drop R2 keys only after commit. */
export const detachImagesFromEntity = async (
  tx: DrizzleTransaction,
  entity: AttachableImageRef,
  imageIds: ImageId[],
): Promise<{ deletedIds: string[]; deletedKeys: string[] }> => {
  if (imageIds.length === 0) return { deletedIds: [], deletedKeys: [] };

  await match(entity)
    .with({ entity: "product" }, ({ id }) =>
      tx
        .delete(productImage)
        .where(
          and(
            eq(productImage.productId, id),
            inArray(productImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "recipe" }, ({ id }) =>
      tx
        .delete(recipeImage)
        .where(
          and(
            eq(recipeImage.recipeId, id),
            inArray(recipeImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "location" }, ({ id }) =>
      tx
        .delete(locationImage)
        .where(
          and(
            eq(locationImage.locationId, id),
            inArray(locationImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "project" }, ({ id }) =>
      tx
        .delete(projectImage)
        .where(
          and(
            eq(projectImage.projectId, id),
            inArray(projectImage.imageId, imageIds),
          ),
        ),
    )
    .with({ entity: "purchase" }, ({ id }) =>
      tx
        .delete(purchaseImage)
        .where(
          and(
            eq(purchaseImage.purchaseId, id),
            inArray(purchaseImage.imageId, imageIds),
          ),
        ),
    )
    .exhaustive();

  return await reapUnreferencedImages(tx, imageIds);
};

/**
 * Of these images, delete the ones nothing points at any more — the shared tail
 * of every removal that drops an association.
 *
 * Call it AFTER the associations are gone (a still-live join row is still a
 * reference), on the same transaction, and drop the returned R2 keys only once
 * that transaction commits. Idempotent and safe on ids that are still
 * referenced: those are simply filtered out.
 *
 * Exported so `removeEntity`'s child cascade can share the reference rules
 * rather than restate them — {@link findReferencedImageIds} is the one place
 * "referenced" is defined, and a second definition is exactly how the detach and
 * delete paths drifted apart in the first place.
 */
export const reapUnreferencedImages = async (
  tx: DrizzleTransaction,
  imageIds: string[],
): Promise<{ deletedIds: string[]; deletedKeys: string[] }> => {
  if (imageIds.length === 0) return { deletedIds: [], deletedKeys: [] };
  const referenced = await findReferencedImageIds(tx, imageIds);
  return await deleteImagesTx(
    tx,
    imageIds.filter((id) => !referenced.has(id)),
  );
};

/**
 * The `imageId` column, if this table is one of `image`'s join tables — i.e. an
 * edge {@link IMAGE_HARD_DELETE} disposes of by deleting the row rather than
 * nulling an FK. Read from `INCOMING_EDGES.image` rather than a hand-kept list,
 * so a sixth gallery entity is picked up here the moment it is declared there.
 *
 * Lets a caller that only knows it is cascading onto some table (`removeEntity`)
 * discover that the rows it is about to remove are image attachments, and read
 * the ids before they stop being findable.
 */
export const imageJoinColumnFor = (table: PgTable): PgColumn | undefined => {
  for (const [key, disposition] of Object.entries(IMAGE_HARD_DELETE)) {
    if (disposition.effect !== "hard-delete") continue;
    const { column } = INCOMING_EDGES.image[key as IncomingEdgeKey<"image">];
    if (column.table === table) return column;
  }
  return undefined;
};

export const UNREFERENCED_IMAGE_GRACE_HOURS = 1;

const unreferencedImageWhere = (db: Database, cutoffDate: Date) =>
  and(
    eq(image.status, "UPLOADED"),
    notDeleted(image),
    lt(image.createdAt, cutoffDate),
    not(activeImageReferenceCondition(db, image)),
  );

/**
 * UPLOADED images no edge still reaches — bytes R2 charges for that nothing can
 * render. The mirror of `findCullablePendingImages`, which only ever swept
 * PENDING rows; that gap is exactly why these accumulated unnoticed. It shares
 * the active-reference SQL used by the Images list, so the detector and that
 * list cannot disagree about whether an image still renders.
 *
 * The grace window is load-bearing, not cosmetic: `importImageFromUrl` and the
 * cookbook cover import create an UPLOADED row and associate it in a SEPARATE
 * step, so a seconds-old unattached row is in flight, not orphaned.
 *
 * Both removal paths now take the file with them — `detachImagesFromEntity` on a
 * detach, `removeEntity` on an entity delete — so this converges to zero and a
 * row here names a removal path that skipped the reap, not a backlog. "Delete
 * unreferenced files" in Settings → Maintenance clears whatever one leaves.
 */
export const findUnreferencedImages = async (
  db: Database,
  olderThanHours: number = UNREFERENCED_IMAGE_GRACE_HOURS,
): Promise<
  Array<{
    id: ImageId;
    key: string;
    filename: string;
    contentType: string;
    size: number;
    createdAt: Date;
    targetType: string | null;
    targetId: string | null;
  }>
> => {
  const dbClient = getDb(db);
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);

  const candidates = await dbClient
    .select({
      id: image.id,
      key: image.key,
      filename: image.filename,
      contentType: image.contentType,
      size: image.size,
      createdAt: image.createdAt,
      targetType: image.targetType,
      targetId: image.targetId,
    })
    .from(image)
    .where(unreferencedImageWhere(db, cutoffDate));
  // `image.id` is an unbranded column, so this is the genuine string -> brand
  // boundary: these are real uuids on their way to `deleteImages`.
  return candidates.map((img) => ({
    ...img,
    id: parseEntityId("image", img.id),
  }));
};

export const countUnreferencedImages = async (
  db: Database,
  olderThanHours: number = UNREFERENCED_IMAGE_GRACE_HOURS,
): Promise<number> => {
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);
  const [row] = await getDb(db)
    .select({ count: sql<number>`count(*)::int` })
    .from(image)
    .where(unreferencedImageWhere(db, cutoffDate));
  return row?.count ?? 0;
};

/**
 * Associate an image with a product.
 *
 * @param db Database client
 * @param productId Product ID to associate the image with
 * @param imageIds Public `IMG-` shortcodes to associate — what
 *   `importImageFromUrl` (image-storage.service.ts) hands back, e.g. from
 *   `importImageFromUPC`. Resolved to uuids here since `associatePendingImages`
 *   writes straight into `ProductImage.imageId`, an unbranded uuid FK.
 */
export const associateImagesWithProduct = async (
  db: Database,
  productId: string,
  imageIds: string[],
): Promise<void> => {
  const resolvedImageIds = await resolveAllPresent(db, "image", imageIds);
  await associatePendingImages(
    getDb(db),
    productImage,
    "productId",
    productId,
    resolvedImageIds,
  );
};

/**
 * Associate an image with a recipe. The recipe counterpart of
 * {@link associateImagesWithProduct} (server-side scrape import — see
 * `importRecipeImageFromUrl`). `imageIds` are public `IMG-` shortcodes,
 * resolved the same way.
 */
export const associateImagesWithRecipe = async (
  db: Database,
  recipeId: RecipeId,
  imageIds: string[],
): Promise<void> => {
  const resolvedImageIds = await resolveAllPresent(db, "image", imageIds);
  await associatePendingImages(
    getDb(db),
    recipeImage,
    "recipeId",
    recipeId,
    resolvedImageIds,
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
        and(
          eq(product.id, parseEntityId("product", entityId)),
          notDeleted(product),
        ),
      ),
    )
    .with("recipe", () =>
      countWhere(
        db,
        recipe,
        and(
          eq(recipe.id, parseEntityId("recipe", entityId)),
          notDeleted(recipe),
        ),
      ),
    )
    .with("location", () =>
      countWhere(
        db,
        location,
        and(
          eq(location.id, parseEntityId("location", entityId)),
          notDeleted(location),
        ),
      ),
    )
    .with("project", () =>
      countWhere(
        db,
        project,
        and(
          eq(project.id, parseEntityId("project", entityId)),
          notDeleted(project),
        ),
      ),
    )
    .with("purchase", () =>
      countWhere(
        db,
        purchase,
        and(
          eq(purchase.id, parseEntityId("purchase", entityId)),
          notDeleted(purchase),
        ),
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

const hasLiveAttachment = async (
  dbc: DrizzleClient | DrizzleTransaction,
  entityType: AttachableImageEntity,
  entityId: string,
  imageId: string,
): Promise<boolean> => {
  const rows = await match(entityType)
    .with("product", () =>
      dbc
        .select({ id: productImage.id })
        .from(productImage)
        .where(
          and(
            eq(productImage.productId, parseEntityId("product", entityId)),
            eq(productImage.imageId, imageId),
            notDeleted(productImage),
          ),
        )
        .limit(1),
    )
    .with("recipe", () =>
      dbc
        .select({ id: recipeImage.id })
        .from(recipeImage)
        .where(
          and(
            eq(recipeImage.recipeId, parseEntityId("recipe", entityId)),
            eq(recipeImage.imageId, imageId),
            notDeleted(recipeImage),
          ),
        )
        .limit(1),
    )
    .with("location", () =>
      dbc
        .select({ id: locationImage.id })
        .from(locationImage)
        .where(
          and(
            eq(locationImage.locationId, parseEntityId("location", entityId)),
            eq(locationImage.imageId, imageId),
            notDeleted(locationImage),
          ),
        )
        .limit(1),
    )
    .with("project", () =>
      dbc
        .select({ id: projectImage.id })
        .from(projectImage)
        .where(
          and(
            eq(projectImage.projectId, parseEntityId("project", entityId)),
            eq(projectImage.imageId, imageId),
            notDeleted(projectImage),
          ),
        )
        .limit(1),
    )
    .with("purchase", () =>
      dbc
        .select({ id: purchaseImage.id })
        .from(purchaseImage)
        .where(
          and(
            eq(purchaseImage.purchaseId, parseEntityId("purchase", entityId)),
            eq(purchaseImage.imageId, imageId),
            notDeleted(purchaseImage),
          ),
        )
        .limit(1),
    )
    .exhaustive();
  return rows.length > 0;
};

/**
 * Locate a previous MCP attachment retry without treating arbitrary Image rows
 * as idempotency winners.
 *
 * `targetType`/`targetId` are PROVENANCE, not a reference — detaching the image
 * leaves them intact, and so does an entity delete (which soft-deletes the join
 * row) and the `Cookbook.coverImageId` set-null path. Matching on them alone
 * made a retry of a detached file report success: no upload, no join row,
 * `imageCount` unchanged, and a response indistinguishable from a real attach.
 * So the keyed lookup only names a candidate; the attachment still has to exist.
 *
 * Defense in depth now that {@link detachImagesFromEntity} deletes the row it
 * detaches, and still load-bearing for the paths that leave a
 * targeted-but-unattached image behind.
 */
export const findAttachmentByIdempotencyKey = async (
  db: Database | DrizzleTransaction,
  entityType: AttachableImageEntity,
  entityId: string,
  idempotencyKey: string,
): Promise<typeof image.$inferSelect | null> => {
  const dbc = "query" in db ? db : getDb(db);
  const candidate = await dbc.query.image.findFirst({
    where: and(
      eq(image.targetType, entityType),
      eq(image.targetId, entityId),
      eq(image.idempotencyKey, idempotencyKey),
      notDeleted(image),
    ),
  });
  if (!candidate) return null;
  return (await hasLiveAttachment(dbc, entityType, entityId, candidate.id))
    ? candidate
    : null;
};

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
            eq(productImage.productId, parseEntityId("product", entityId)),
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
            eq(recipeImage.recipeId, parseEntityId("recipe", entityId)),
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
            eq(locationImage.locationId, parseEntityId("location", entityId)),
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
            eq(projectImage.projectId, parseEntityId("project", entityId)),
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
            eq(purchaseImage.purchaseId, parseEntityId("purchase", entityId)),
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
          and(
            eq(product.id, parseEntityId("product", entityId)),
            notDeleted(product),
          ),
        )
        .for("update"),
    )
    .with("recipe", () =>
      tx
        .select({ id: recipe.id })
        .from(recipe)
        .where(
          and(
            eq(recipe.id, parseEntityId("recipe", entityId)),
            notDeleted(recipe),
          ),
        )
        .for("update"),
    )
    .with("location", () =>
      tx
        .select({ id: location.id })
        .from(location)
        .where(
          and(
            eq(location.id, parseEntityId("location", entityId)),
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
          and(
            eq(project.id, parseEntityId("project", entityId)),
            notDeleted(project),
          ),
        )
        .for("update"),
    )
    .with("purchase", () =>
      tx
        .select({ id: purchase.id })
        .from(purchase)
        .where(
          and(
            eq(purchase.id, parseEntityId("purchase", entityId)),
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
            eq(productImage.productId, parseEntityId("product", entityId)),
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
            eq(recipeImage.recipeId, parseEntityId("recipe", entityId)),
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
            eq(locationImage.locationId, parseEntityId("location", entityId)),
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
            eq(projectImage.projectId, parseEntityId("project", entityId)),
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
            eq(purchaseImage.purchaseId, parseEntityId("purchase", entityId)),
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
  imageId: ImageId,
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
        purchaseId: parseEntityId("purchase", entityId),
        imageId,
        sortOrder,
        documentKind: documentKind ?? "other",
      });
      await dbc
        .update(purchase)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(purchase.id, parseEntityId("purchase", entityId)),
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
    // Minted inline rather than via `insertWithShortcode`: this insert needs
    // `onConflictDoNothing` on the idempotency key, and the helper's own
    // collision retry would fight that. A code burned by a no-op conflict is
    // fine — shortcodes are never reused, so an unused one is simply retired.
    const shortcode = await generateUniqueShortcode(tx, "image");
    const [inserted] = await tx
      .insert(image)
      .values({
        ...record,
        shortcode,
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
        // Conflicted with a row the liveness check then rejected: the partial
        // unique index spans unattached rows, so a stale one still owns this
        // key. `detachImagesFromEntity` no longer produces those; a row here
        // means some removal path left one behind and `findUnreferencedImages`
        // will be reporting it.
        throw createAppError(
          "IMAGE_ATTACH_FAILED",
          `A detached file still holds idempotencyKey "${params.idempotencyKey}" for this ${entityType}. ` +
            "Retry with a different key, and check Problems → unreferenced files.",
        );
      }
      throw new Error("Image attachment insert unexpectedly returned no row");
    }
    await associateImageWithEntity(
      tx,
      entityType,
      entityId,
      parseEntityId("image", inserted.id),
      documentKind,
    );
    return { row: inserted, reused: false };
  });

export const getImagesByProjectIds = async (
  db: Database,
  projectIds: ProjectId[],
): Promise<
  Record<string, Array<{ id: ImageShortcode; url: string; filename: string }>>
> => {
  if (projectIds.length === 0) return {};

  const rows = await getDb(db)
    .select({
      projectId: projectImage.projectId,
      shortcode: image.shortcode,
      key: image.key,
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
    Array<{ id: ImageShortcode; url: string; filename: string }>
  > = {};
  for (const row of rows) {
    const list = result[row.projectId] ?? [];
    list.push({
      id: parseShortcodeFor("image", row.shortcode),
      url: getR2PublicUrl(row.key),
      filename: row.filename,
    });
    result[row.projectId] = list;
  }
  return result;
};
