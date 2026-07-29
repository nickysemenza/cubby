/**
 * Image repository — the single data-access boundary for the `image` entity and
 * its product / location / recipe association join tables.
 *
 * Public API (consumed by routers + services; keep these signatures stable):
 * - {@link imageList}                         — paginated/sorted/filtered list with entity associations
 * - {@link getImageById}                      — fetch one image with its entity association
 * - {@link updateImage}                       — rename an image (the one safely user-editable column)
 * - {@link markImageUploaded}                 — flip a PENDING row to UPLOADED once the R2 PUT succeeds
 * - {@link cullPendingImages}                 — delete stale unassociated PENDING rows and return their keys
 * - {@link countCullablePendingImages}        — how many rows that cull would remove
 * - {@link deleteImages}                      — hard-delete image rows (+ their associations) and return their keys
 * - {@link associateImagesWithProduct}        — attach PENDING images to a product
 * - {@link associateImagesWithRecipe}         — attach PENDING images to a recipe
 *
 * Storage/network orchestration lives in image-storage.service.ts.
 */

import type { ProjectId, RecipeId } from "@cubby/schemas/identifiers";
import {
  unsafeLocationId,
  unsafeProductId,
  unsafeProjectId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type {
  AttachableImageEntity,
  ImageUpdateInput,
  ImageWithEntity,
} from "@cubby/schemas/image";
import { imageSortableFields } from "@cubby/schemas/image";
import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { match } from "ts-pattern";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  image,
  location,
  locationImage,
  product,
  productImage,
  project,
  projectImage,
  recipe,
  recipeImage,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  associatePendingImages,
  buildOrderBy,
  countWhere,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  isNotDeleted,
  notDeleted,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";

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
  },
) => {
  return await insertAndReturn(db, image, {
    ...params,
    status: "UPLOADED",
  });
};

// Type for image with pre-loaded entity relations
// Note: Association deletedAt is filtered at query time, but we still need to check entity deletedAt
type ImageWithRelations = typeof image.$inferSelect & {
  productImages: Array<{
    productId: string;
    product: { name: string; deletedAt: Date | null };
  }>;
  locationImages: Array<{
    locationId: string;
    location: { name: string; deletedAt: Date | null };
  }>;
  recipeImages: Array<{
    recipeId: string;
    recipe: { name: string; deletedAt: Date | null };
  }>;
  projectImages: Array<{
    projectId: string;
    project: { name: string; deletedAt: Date | null };
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
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "PRODUCT",
      entityId: productAssoc.productId,
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
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "LOCATION",
      entityId: locationAssoc.locationId,
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
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "RECIPE",
      entityId: recipeAssoc.recipeId,
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
      createdAt: imageData.createdAt,
      updatedAt: imageData.updatedAt,
      entityType: "PROJECT",
      entityId: projectAssoc.projectId,
      entityName: projectAssoc.project.name,
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
        columns: { name: true, deletedAt: true },
      },
    },
    columns: { productId: true },
  },
  locationImages: {
    where: notDeleted(locationImage),
    with: {
      location: {
        columns: { name: true, deletedAt: true },
      },
    },
    columns: { locationId: true },
  },
  recipeImages: {
    where: notDeleted(recipeImage),
    with: {
      recipe: {
        columns: { name: true, deletedAt: true },
      },
    },
    columns: { recipeId: true },
  },
  projectImages: {
    where: notDeleted(projectImage),
    with: {
      project: {
        columns: { name: true, deletedAt: true },
      },
    },
    columns: { projectId: true },
  },
} as const;

/**
 * List images with pagination, sorting, and filtering
 * This follows the consistent pattern used in other list functions
 */
export const imageList = async (
  db: Database,
  filterText: string | undefined,
  sorts: Array<{ orderBy: string; direction: "asc" | "desc" }>,
  pagination: { pageIndex: number; pageSize: number },
) => {
  const dbClient = getDb(db);

  // Build where conditions
  const whereConditions: ReturnType<typeof eq>[] = [];
  const filenameCondition = formatSearchTerm(image.filename, filterText);
  if (filenameCondition) {
    whereConditions.push(filenameCondition);
  }

  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  // Build orderBy using central sortableFields config
  const orderByClause = buildOrderBy(image, sorts, [...imageSortableFields]);

  // Calculate skip/take values from pagination parameters
  const take = pagination.pageSize;
  const skip = pagination.pageIndex * pagination.pageSize;

  // Execute queries in parallel - load entity relations in single query
  const [images, count] = await Promise.all([
    dbClient.query.image.findMany({
      where: whereClause,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
      with: imageEntityRelations,
    }),
    countWhere(db, image, whereClause),
  ]);

  // Transform images with pre-loaded relations (no additional queries)
  const processedImages = images.map(imageWithRelationsToAPI);

  return {
    data: processedImages,
    count,
  };
};

/**
 * Get image by ID with entity association information
 */
export const getImageById = async (
  db: Database,
  imageId: string,
): Promise<ImageWithEntity> => {
  // Find the image by ID with entity relations
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

/**
 * Get an image by its S3 key
 * Returns null if not found (used for checking if image already exists in DB)
 */
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

  // Calculate the cutoff date
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);

  // Find all images that have associations
  const imagesWithProductAssociations = dbClient
    .select({ imageId: productImage.imageId })
    .from(productImage);

  const imagesWithLocationAssociations = dbClient
    .select({ imageId: locationImage.imageId })
    .from(locationImage);

  const imagesWithRecipeAssociations = dbClient
    .select({ imageId: recipeImage.imageId })
    .from(recipeImage);

  const imagesWithProjectAssociations = dbClient
    .select({ imageId: projectImage.imageId })
    .from(projectImage);

  // A cookbook cover is a DIRECT FK, not a join row, so enumerating only the
  // four join tables misses it — and this feeds a HARD delete wired to the
  // one-click auto-fix. `deleteImages` below already handles this edge
  // explicitly; that asymmetry was the omission, not a decision. Currently
  // unreachable (upsertCookbook flips a cover to UPLOADED in the same txn that
  // writes coverImageId, and this only looks at PENDING), but nothing enforces
  // that pairing and the failure mode is a raw FK violation aborting the whole
  // cull *after* the caller has dropped the R2 objects.
  //
  // Deliberately NOT filtered by `notDeleted(cookbook)`: deleteCookbook
  // tombstones the row without nulling coverImageId, so a soft-deleted cookbook
  // still holds a live FK. The constraint doesn't care about deletedAt, and this
  // cull is a hard delete — filtering here would cull exactly the images that
  // then blow up on Cookbook_coverImageId_fkey.
  const imagesUsedAsCookbookCovers = dbClient
    .select({ imageId: cookbook.coverImageId })
    .from(cookbook)
    .where(isNotNull(cookbook.coverImageId));

  // Get all image IDs that have any association
  const [
    productAssocs,
    locationAssocs,
    recipeAssocs,
    projectAssocs,
    cookbookCovers,
  ] = await Promise.all([
    imagesWithProductAssociations,
    imagesWithLocationAssociations,
    imagesWithRecipeAssociations,
    imagesWithProjectAssociations,
    imagesUsedAsCookbookCovers,
  ]);

  const associatedImageIds = new Set([
    ...productAssocs.map((a) => a.imageId),
    ...locationAssocs.map((a) => a.imageId),
    ...recipeAssocs.map((a) => a.imageId),
    ...projectAssocs.map((a) => a.imageId),
    ...cookbookCovers.map((a) => a.imageId),
  ]);

  // Find pending images older than the cutoff date
  const allPendingImages = await dbClient.query.image.findMany({
    where: and(eq(image.status, "PENDING"), lt(image.createdAt, cutoffDate)),
    columns: {
      id: true,
      key: true,
    },
  });

  // Filter out images that have associations
  return allPendingImages.filter((img) => !associatedImageIds.has(img.id));
};

/** How many abandoned uploads the cull would remove right now. */
export const countCullablePendingImages = async (
  db: Database,
  olderThanHours: number,
): Promise<number> =>
  (await findCullablePendingImages(db, olderThanHours)).length;

/**
 * Cull (delete) pending images that are older than the specified threshold
 * @param db Database client
 * @param olderThanHours Delete images older than this many hours
 * @returns Object with count of deleted images and related information
 */
export const cullPendingImages = async (
  db: Database,
  olderThanHours: number,
) => {
  const pendingImages = await findCullablePendingImages(db, olderThanHours);

  if (pendingImages.length === 0) {
    return { count: 0, deletedIds: [], deletedKeys: [] };
  }

  // Get the IDs of images to delete
  const imageIds = pendingImages.map((img) => img.id);
  const imageKeys = pendingImages.map((img) => img.key);

  // Delete the images from the database
  await getDb(db).delete(image).where(inArray(image.id, imageIds));

  // Return the result
  return {
    count: pendingImages.length,
    deletedIds: imageIds,
    deletedKeys: imageKeys,
  };
};

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
 * The join rows are deleted first (they FK the image), which
 * also detaches the image from whatever product/location/recipe/project owned
 * it. Missing ids are skipped; the returned keys are only those actually removed.
 */
export const deleteImages = async (
  db: Database,
  imageIds: string[],
): Promise<{ deletedIds: string[]; deletedKeys: string[] }> => {
  if (imageIds.length === 0) return { deletedIds: [], deletedKeys: [] };

  return await withTransaction(db, async (tx) => {
    const rows = await tx.query.image.findMany({
      where: inArray(image.id, imageIds),
      columns: { id: true, key: true },
    });
    if (rows.length === 0) return { deletedIds: [], deletedKeys: [] };

    const ids = rows.map((row) => row.id);

    // Join rows reference the image — clear them before the image itself.
    await tx.delete(productImage).where(inArray(productImage.imageId, ids));
    await tx.delete(locationImage).where(inArray(locationImage.imageId, ids));
    await tx.delete(recipeImage).where(inArray(recipeImage.imageId, ids));
    await tx.delete(projectImage).where(inArray(projectImage.imageId, ids));

    // Cookbook covers are a direct FK (not a join row) — drop the reference so
    // the delete can't violate it; the cookbook simply loses its cover.
    await tx
      .update(cookbook)
      .set({ coverImageId: null })
      .where(inArray(cookbook.coverImageId, ids));

    await tx.delete(image).where(inArray(image.id, ids));

    return { deletedIds: ids, deletedKeys: rows.map((row) => row.key) };
  });
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
    .exhaustive();
  if (count === 0) {
    throw createAppError(
      "IMAGE_ATTACH_FAILED",
      `${entityType} ${entityId} not found`,
    );
  }
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
  },
  entityType: AttachableImageEntity,
  entityId: string,
): Promise<typeof image.$inferSelect> => {
  return await withTransaction(db, async (tx) => {
    const row = await createUploadedImageRecord(tx, params);
    await associateImageWithEntity(tx, entityType, entityId, row.id);
    return row;
  });
};

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
