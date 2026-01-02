import { and, eq, ilike, inArray, lt, sql } from "drizzle-orm";
import { getSortableFields } from "~/entities/entities";
import type {
  ImageWithEntity,
  InitiateUploadWithoutEntityInput,
} from "~/schemas/image";
import { createAppError } from "~/server/api/trpc";
import type { Database } from "~/server/db";
import {
  image,
  locationImage,
  productImage,
  recipeImage,
} from "~/server/db/schema";
import {
  associatePendingImages,
  buildOrderBy,
  getDb,
  insertAndReturnDb,
} from "~/server/repo/database-helpers";
import {
  contentTypeToExtension,
  deleteS3Object,
  fetchAndStoreImage,
  generateImageKey,
  generatePresignedUploadUrl,
  getS3ObjectUrl,
} from "../utils/s3";

/**
 * Initiate an image upload without associating it with an entity yet
 * This is used for uploading images during entity creation
 */
export const initiateImageUploadWithoutEntity = async (
  db: Database,
  { filename, contentType, size }: InitiateUploadWithoutEntityInput,
) => {
  // Generate S3 key for the image
  const key = generateImageKey(filename);
  const url = getS3ObjectUrl(key);

  // Create image record in pending state
  const createdImage = await insertAndReturnDb(db, image, {
    key,
    filename,
    size,
    contentType,
    url,
    status: "PENDING",
  });

  // Generate presigned URL for upload
  const uploadUrl = await generatePresignedUploadUrl({
    key,
    contentType,
  });

  return {
    uploadUrl,
    imageId: createdImage.id,
    key,
    url,
  };
};

// Type for image with pre-loaded entity relations
type ImageWithRelations = typeof image.$inferSelect & {
  productImages: Array<{
    productId: string;
    product: { name: string };
  }>;
  locationImages: Array<{
    locationId: string;
    location: { name: string };
  }>;
  recipeImages: Array<{
    recipeId: string;
    recipe: { name: string };
  }>;
};

/**
 * Transform image with pre-loaded relations to API format.
 * Expects relations to be loaded via `with` clause - no additional queries.
 */
const imageWithRelationsToAPI = (
  imageData: ImageWithRelations,
): ImageWithEntity => {
  // Check product associations (pre-loaded)
  const productAssoc = imageData.productImages[0];
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

  // Check location associations (pre-loaded)
  const locationAssoc = imageData.locationImages[0];
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

  // Check recipe associations (pre-loaded)
  const recipeAssoc = imageData.recipeImages[0];
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

/** Shared relation config for loading entity associations */
const imageEntityRelations = {
  productImages: {
    with: { product: { columns: { name: true } } },
    columns: { productId: true },
    limit: 1,
  },
  locationImages: {
    with: { location: { columns: { name: true } } },
    columns: { locationId: true },
    limit: 1,
  },
  recipeImages: {
    with: { recipe: { columns: { name: true } } },
    columns: { recipeId: true },
    limit: 1,
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
  if (filterText && filterText.trim() !== "") {
    whereConditions.push(ilike(image.filename, `%${filterText}%`));
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
  const [images, countResult] = await Promise.all([
    dbClient.query.image.findMany({
      where: whereClause,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
      with: imageEntityRelations,
    }),
    dbClient
      .select({ count: sql<number>`count(*)::int` })
      .from(image)
      .where(whereClause),
  ]);

  // Transform images with pre-loaded relations (no additional queries)
  const processedImages = images.map(imageWithRelationsToAPI);

  return {
    data: processedImages,
    count: countResult[0].count,
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

  // Delete from S3 (this would be better in a transaction or with error handling)
  // We're ignoring S3 deletion errors to ensure the database cleanup completes
  try {
    for (const key of imageKeys) {
      await deleteS3Object(key);
    }
  } catch (error) {
    console.error("Error deleting images from S3:", error);
  }

  // Return the result
  return {
    count: pendingImages.length,
    deletedIds: imageIds,
    deletedKeys: imageKeys,
  };
};

/**
 * Import an image from an external URL and store it in our system.
 * Creates an image record with status "UPLOADED" (not PENDING, since it's already uploaded).
 *
 * @param db Database client
 * @param params.sourceUrl The external URL to fetch the image from
 * @param params.filenamePrefix Prefix for the generated filename (e.g., "upc-123456789012")
 * @returns Object with imageId, key, and url, or null on failure
 */
export const importImageFromUrl = async (
  db: Database,
  params: { sourceUrl: string; filenamePrefix: string },
): Promise<{ imageId: string; key: string; url: string } | null> => {
  // Fetch and store the image in R2
  const stored = await fetchAndStoreImage(
    params.sourceUrl,
    params.filenamePrefix,
  );

  if (!stored) {
    return null;
  }

  // Create the image record with status UPLOADED (not PENDING)
  const createdImage = await insertAndReturnDb(db, image, {
    key: stored.key,
    filename: `${params.filenamePrefix}.${contentTypeToExtension(stored.contentType)}`,
    size: stored.size,
    contentType: stored.contentType,
    url: stored.url,
    status: "UPLOADED",
  });

  return {
    imageId: createdImage.id,
    key: stored.key,
    url: stored.url,
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
