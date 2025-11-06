import { TRPCError } from "@trpc/server";
import {
  generateImageKey,
  generatePresignedUploadUrl,
  getS3ObjectUrl,
  deleteS3Object,
} from "../utils/s3";
import {
  type InitiateUploadWithoutEntityInput,
  type ImageWithEntity,
} from "~/schemas/image";
import { type Database } from "~/server/db";
import {
  getDb,
  buildOrderBy,
  insertAndReturnDb,
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
  filterText: string | undefined,
  sort: { orderBy: string; direction: "asc" | "desc" },
  pagination: { pageIndex: number; pageSize: number },
) => {
  const dbClient = getDb(db);

  // Build where conditions
  const whereConditions = [];
  if (filterText && filterText.trim() !== "") {
    whereConditions.push(ilike(image.filename, `%${filterText}%`));
  }

  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

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
    count: countResult[0]?.count ?? 0,
  };
};

/**
 * Get image by ID with entity association information
 */
export const getImageById = async (
  db: Database,
  imageId: string,
): Promise<ImageWithEntity> => {
  // Find the image by ID
  const imageRecord = await getDb(db).query.image.findFirst({
    where: eq(image.id, imageId),
  });

  if (!imageRecord) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Image not found",
    });
  }

  // Use the dbImageToAPI helper to transform the image
  return dbImageToAPI(db, imageRecord);
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
