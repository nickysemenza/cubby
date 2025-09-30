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
import { type Prisma, type PrismaClient } from "@prisma/client";

/**
 * Initiate an image upload without associating it with an entity yet
 * This is used for uploading images during entity creation
 */
export const initiateImageUploadWithoutEntity = async (
  db: PrismaClient,
  { filename, contentType, size }: InitiateUploadWithoutEntityInput,
  projectId: string,
) => {
  // Generate S3 key for the image
  const key = generateImageKey(filename);
  const url = getS3ObjectUrl(key);

  // Create image record in pending state
  const image = await db.image.create({
    data: {
      projectId,
      key,
      filename,
      size,
      contentType,
      url,
      status: "PENDING",
    },
  });

  // Generate presigned URL for upload
  const uploadUrl = await generatePresignedUploadUrl({
    key,
    contentType,
  });

  return {
    uploadUrl,
    imageId: image.id,
    key,
    url,
  };
};

// Define the type for database image
type ImageDB = Prisma.ImageGetPayload<object>;

/**
 * Get image with entity information (DB to API helper function)
 */
const dbImageToAPI = async (
  db: PrismaClient,
  image: ImageDB,
): Promise<ImageWithEntity> => {
  // Check product associations
  const productImage = await db.productImage.findFirst({
    where: { imageId: image.id },
    include: { product: true },
  });

  if (productImage) {
    return {
      ...image,
      entityType: "PRODUCT",
      entityId: productImage.productId,
      entityName: productImage.product.name,
    };
  }

  // Check location associations
  const locationImage = await db.locationImage.findFirst({
    where: { imageId: image.id },
    include: { location: true },
  });

  if (locationImage) {
    return {
      ...image,
      entityType: "LOCATION",
      entityId: locationImage.locationId,
      entityName: locationImage.location.name,
    };
  }

  // Check recipe associations
  const recipeImage = await db.recipeImage.findFirst({
    where: { imageId: image.id },
    include: { recipe: true },
  });

  if (recipeImage) {
    return {
      ...image,
      entityType: "RECIPE",
      entityId: recipeImage.recipeId,
      entityName: recipeImage.recipe.name,
    };
  }

  // No entity association found
  return {
    ...image,
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
  db: PrismaClient,
  filterText: string | undefined,
  sort: { orderBy: string; direction: "asc" | "desc" },
  pagination: { pageIndex: number; pageSize: number },
) => {
  // Set up where clause for filtering
  const where: Prisma.ImageWhereInput = {};

  // Add search filter if provided
  if (filterText && filterText.trim() !== "") {
    where.filename = {
      contains: filterText,
      mode: "insensitive",
    };
  }

  // Define sort order based on provided field or default to createdAt
  const orderBy: Prisma.ImageOrderByWithRelationInput = {};
  const sortField = sort.orderBy || "createdAt";
  const direction = sort.direction || "desc";

  // Only set ordering on valid fields to avoid runtime errors
  if (
    sortField === "createdAt" ||
    sortField === "updatedAt" ||
    sortField === "filename" ||
    sortField === "size" ||
    sortField === "status"
  ) {
    orderBy[sortField] = direction;
  } else {
    // Default to createdAt if the sort field is not valid
    orderBy.createdAt = direction;
  }

  // Calculate skip/take values from pagination parameters
  const take = pagination.pageSize;
  const skip = pagination.pageIndex * pagination.pageSize;

  // Execute queries in a transaction for consistency
  const [images, count] = await db.$transaction([
    db.image.findMany({
      orderBy,
      where,
      take,
      skip,
    }),
    db.image.count({ where }),
  ]);

  // Process images to include entity information
  const processedImages = await Promise.all(
    images.map(async (image) => await dbImageToAPI(db, image)),
  );

  return {
    data: processedImages,
    count,
  };
};

/**
 * Get image by ID with entity association information
 */
export const getImageById = async (
  db: PrismaClient,
  imageId: string,
): Promise<ImageWithEntity> => {
  // Find the image by ID
  const image = await db.image.findUnique({
    where: { id: imageId },
  });

  if (!image) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Image not found",
    });
  }

  // Use the dbImageToAPI helper to transform the image
  return dbImageToAPI(db, image);
};

/**
 * Cull (delete) pending images that are older than the specified threshold
 * @param db Prisma client
 * @param olderThanHours Delete images older than this many hours
 * @returns Object with count of deleted images and related information
 */
export const cullPendingImages = async (
  db: PrismaClient,
  olderThanHours: number,
) => {
  // Calculate the cutoff date
  const cutoffDate = new Date();
  cutoffDate.setHours(cutoffDate.getHours() - olderThanHours);

  // Find pending images older than the cutoff date
  const pendingImages = await db.image.findMany({
    where: {
      status: "PENDING",
      createdAt: {
        lt: cutoffDate,
      },
      // Ensure the image is not associated with any entity
      productImages: { none: {} },
      locationImages: { none: {} },
      recipeImages: { none: {} },
    },
    select: {
      id: true,
      key: true,
    },
  });

  if (pendingImages.length === 0) {
    return { count: 0, deletedIds: [], deletedKeys: [] };
  }

  // Get the IDs of images to delete
  const imageIds = pendingImages.map((img) => img.id);
  const imageKeys = pendingImages.map((img) => img.key);

  // Delete the images from the database
  await db.image.deleteMany({
    where: {
      id: { in: imageIds },
    },
  });

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
