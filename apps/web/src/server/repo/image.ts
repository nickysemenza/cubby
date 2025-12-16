import { createAppError } from "~/server/api/trpc";
import {
  generateImageKey,
  generatePresignedUploadUrl,
  getS3ObjectUrl,
  deleteS3Object,
} from "../utils/s3";
import { fetchAndStoreImage } from "../utils/image-import";
import {
  type InitiateUploadWithoutEntityInput,
  type ImageWithEntity,
} from "~/schemas/image";
import { type Database } from "~/server/db";
import {
  getDb,
  buildOrderBy,
  insertAndReturnDb,
  associatePendingImages,
} from "~/server/repo/database-helpers";
import {
  image,
  productImage,
  locationImage,
  recipeImage,
} from "~/server/db/schema";
import { eq, and, inArray, sql, lt, ilike } from "drizzle-orm";

/**
 * Initiate an image upload without associating it with an entity yet
 * This is used for uploading images during entity creation
 */
export const initiateImageUploadWithoutEntity = async (
  db: Database,
  { filename, contentType, size }: InitiateUploadWithoutEntityInput,
  organizationId: string,
) => {
  // Generate S3 key for the image
  const key = generateImageKey(filename);
  const url = getS3ObjectUrl(key);

  // Create image record in pending state
  const createdImage = await insertAndReturnDb(db, image, {
    organizationId,
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

// Define the type for database image
type ImageDB = typeof image.$inferSelect;

/**
 * Get image with entity information (DB to API helper function)
 */
const dbImageToAPI = async (
  db: Database,
  imageData: ImageDB,
): Promise<ImageWithEntity> => {
  // Check product associations
  const productImageRec = await getDb(db).query.productImage.findFirst({
    where: eq(productImage.imageId, imageData.id),
    with: { product: true },
  });

  if (productImageRec) {
    return {
      ...imageData,
      entityType: "PRODUCT",
      entityId: productImageRec.productId,
      entityName: productImageRec.product.name,
    };
  }

  // Check location associations
  const locationImageRec = await getDb(db).query.locationImage.findFirst({
    where: eq(locationImage.imageId, imageData.id),
    with: { location: true },
  });

  if (locationImageRec) {
    return {
      ...imageData,
      entityType: "LOCATION",
      entityId: locationImageRec.locationId,
      entityName: locationImageRec.location.name,
    };
  }

  // Check recipe associations
  const recipeImageRec = await getDb(db).query.recipeImage.findFirst({
    where: eq(recipeImage.imageId, imageData.id),
    with: { recipe: true },
  });

  if (recipeImageRec) {
    return {
      ...imageData,
      entityType: "RECIPE",
      entityId: recipeImageRec.recipeId,
      entityName: recipeImageRec.recipe.name,
    };
  }

  // No entity association found
  return {
    ...imageData,
    entityType: null,
    entityId: null,
    entityName: null,
  };
};

/**
 * List images with pagination, sorting, and filtering
 * This follows the consistent pattern used in other list functions
 */
export const imageList = async (
  db: Database,
  organizationId: string,
  filterText: string | undefined,
  sort: { orderBy: string; direction: "asc" | "desc" },
  pagination: { pageIndex: number; pageSize: number },
) => {
  const dbClient = getDb(db);

  // Build where conditions - always include organization filter for security
  const whereConditions = [eq(image.organizationId, organizationId)];
  if (filterText && filterText.trim() !== "") {
    whereConditions.push(ilike(image.filename, `%${filterText}%`));
  }

  const whereClause = and(...whereConditions);

  // Build orderBy using helper
  const orderByClause = buildOrderBy(image, sort, [
    "createdAt",
    "updatedAt",
    "filename",
    "size",
    "status",
  ]);

  // Calculate skip/take values from pagination parameters
  const take = pagination.pageSize;
  const skip = pagination.pageIndex * pagination.pageSize;

  // Execute queries in parallel
  const [images, countResult] = await Promise.all([
    dbClient.query.image.findMany({
      where: whereClause,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
    }),
    dbClient
      .select({ count: sql<number>`count(*)::int` })
      .from(image)
      .where(whereClause),
  ]);

  // Process images to include entity information
  const processedImages = await Promise.all(
    images.map(async (img) => await dbImageToAPI(db, img)),
  );

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
  organizationId: string,
  imageId: string,
): Promise<ImageWithEntity> => {
  // Find the image by ID with organization filter for security
  const imageRecord = await getDb(db).query.image.findFirst({
    where: and(eq(image.id, imageId), eq(image.organizationId, organizationId)),
  });

  if (!imageRecord) {
    throw createAppError("IMAGE_NOT_FOUND", "Image not found");
  }

  // Use the dbImageToAPI helper to transform the image
  return dbImageToAPI(db, imageRecord);
};

/**
 * Cull (delete) pending images that are older than the specified threshold
 * @param db Database client
 * @param organizationId Organization ID to scope the cull to
 * @param olderThanHours Delete images older than this many hours
 * @returns Object with count of deleted images and related information
 */
export const cullPendingImages = async (
  db: Database,
  organizationId: string,
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

  // Find pending images older than the cutoff date, scoped to organization
  const allPendingImages = await dbClient.query.image.findMany({
    where: and(
      eq(image.organizationId, organizationId),
      eq(image.status, "PENDING"),
      lt(image.createdAt, cutoffDate),
    ),
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
 * @param organizationId Organization ID for the image
 * @param params.sourceUrl The external URL to fetch the image from
 * @param params.filenamePrefix Prefix for the generated filename (e.g., "upc-123456789012")
 * @returns Object with imageId, key, and url, or null on failure
 */
export const importImageFromUrl = async (
  db: Database,
  organizationId: string,
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
    organizationId,
    key: stored.key,
    filename: `${params.filenamePrefix}.${stored.contentType.split("/")[1] || "jpg"}`,
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
