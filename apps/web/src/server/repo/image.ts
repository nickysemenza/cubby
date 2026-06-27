/**
 * Image repository — the single data-access boundary for the `image` entity and
 * its product / location / recipe association join tables.
 *
 * Public API (consumed by routers + services; keep these signatures stable):
 * - {@link imageList}                         — paginated/sorted/filtered list with entity associations
 * - {@link getImageById}                      — fetch one image with its entity association
 * - {@link cullPendingImages}                 — delete stale unassociated PENDING rows and return their keys
 * - {@link associateImagesWithProduct}        — attach PENDING images to a product
 *
 * Storage/network orchestration lives in image-storage.service.ts.
 */

import type { InitiateUploadWithoutEntityInput } from "@cubby/schemas/image";
import type { ImageWithEntity } from "@cubby/schemas/image-responses";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getSortableFields } from "~/entities/entities";
import type { Database } from "~/server/db";
import {
  image,
  locationImage,
  productImage,
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
} from "~/server/repo/database-helpers";

export const createPendingImageRecord = async (
  db: Database,
  {
    key,
    url,
    filename,
    contentType,
    size,
  }: InitiateUploadWithoutEntityInput & { key: string; url: string },
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
  db: Database,
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
} as const;

/**
 * List images with pagination, sorting, and filtering
 * This follows the consistent pattern used in other list functions
 */
export const imageList = async (
  db: Database,
  filterText: string | undefined,
  sort: { orderBy: string; direction: "asc" | "desc" },
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
  const orderByClause = buildOrderBy(image, sort, [
    ...getSortableFields("image"),
  ]);

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
 * Cull (delete) pending images that are older than the specified threshold
 * @param db Database client
 * @param olderThanHours Delete images older than this many hours
 * @returns Object with count of deleted images and related information
 */
export const cullPendingImages = async (
  db: Database,
  olderThanHours: number,
) => {
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

  // Get all image IDs that have any association
  const [productAssocs, locationAssocs, recipeAssocs] = await Promise.all([
    imagesWithProductAssociations,
    imagesWithLocationAssociations,
    imagesWithRecipeAssociations,
  ]);

  const associatedImageIds = new Set([
    ...productAssocs.map((a) => a.imageId),
    ...locationAssocs.map((a) => a.imageId),
    ...recipeAssocs.map((a) => a.imageId),
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
  const pendingImages = allPendingImages.filter(
    (img) => !associatedImageIds.has(img.id),
  );

  if (pendingImages.length === 0) {
    return { count: 0, deletedIds: [], deletedKeys: [] };
  }

  // Get the IDs of images to delete
  const imageIds = pendingImages.map((img) => img.id);
  const imageKeys = pendingImages.map((img) => img.key);

  // Delete the images from the database
  await dbClient.delete(image).where(inArray(image.id, imageIds));

  // Return the result
  return {
    count: pendingImages.length,
    deletedIds: imageIds,
    deletedKeys: imageKeys,
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
