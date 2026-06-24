import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { entityImage } from "./entity";
import { id } from "./identifiers";
import {
  createPaginatedResponseSchema,
  sortPaginationCombo,
} from "./pagination";

// Image status values - single source of truth for both Zod and Drizzle
export const imageStatusValues = ["PENDING", "UPLOADED", "FAILED"] as const;

// Image status enum
export const ImageStatus = z.enum(imageStatusValues);
export type ImageStatus = z.infer<typeof ImageStatus>;

// Allowed image content types for upload validation
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];
const imageContentType = z.enum(ALLOWED_IMAGE_TYPES);

// Base schema for image data (contentType is string for DB output compatibility)
const imageBase = z.object({
  url: z.url(),
  key: z.string(),
  filename: z.string(),
  size: z.int().positive(),
  contentType: z.string(),
  status: ImageStatus,
});

// Schema for image output (response)
export const imageOut = z
  .object({
    id: id,
  })
  .extend(imageBase.shape)
  .extend(dbTimestampsOut.shape);

export type ImageOut = z.infer<typeof imageOut>;

// Common image input schemas for create and update operations
export const createInputImages = z.object({
  pendingImageIds: z.array(z.uuid()).optional(),
});

export const updateInputImages = z
  .object({
    removeImageIds: z.array(z.uuid()).optional(),
  })
  .extend(createInputImages.shape);

export type UpdateInputImages = z.infer<typeof updateInputImages>;

// Max image upload size (~50MB) — server refuses presigned URLs for absurd sizes.
export const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;

// Schema for initiating an image upload without entity ID (for pending uploads)
export const initiateUploadWithoutEntitySchema = z.object({
  filename: z.string(),
  contentType: imageContentType,
  size: z.int().positive().max(MAX_IMAGE_UPLOAD_BYTES),
  entityType: entityImage,
});

export type InitiateUploadWithoutEntityInput = z.infer<
  typeof initiateUploadWithoutEntitySchema
>;

// Response for initiating an upload without entity ID
export const initiateUploadWithoutEntityResponseSchema = z.object({
  uploadUrl: z.url(),
  imageId: id,
  key: z.string(),
  url: z.url(),
});

// Schema for getting image by ID
export const getImageByIdSchema = z.object({
  id: id,
});

// Image with entity information
export const imageWithEntitySchema = imageOut.extend({
  entityType: entityImage.nullable(),
  entityId: id.nullable(),
  entityName: z.string().nullable(),
});

export type ImageWithEntity = z.infer<typeof imageWithEntitySchema>;

// New schema for standardized list endpoint
export const imageListFiltersSchema = z
  .object({
    filters: z.object({
      searchFilter: z.string().optional(),
    }),
  })
  .extend(sortPaginationCombo.shape);

// New response schema using the standard paginated response format
export const imageListResponseSchema = createPaginatedResponseSchema(
  imageWithEntitySchema,
);

// Schema for importing an image from a URL
export const importImageFromUrlSchema = z.object({
  url: z.url(),
  entityType: entityImage,
});

// Response schema for importing an image from a URL
export const importImageFromUrlResponseSchema = z.object({
  imageId: id,
  key: z.string(),
  url: z.url(),
  filename: z.string(),
});

// Schema for culling pending images
export const cullPendingImagesSchema = z.object({
  olderThanHours: z.int().positive().default(24),
});

// Response schema for culling pending images
export const cullPendingImagesResponseSchema = z.object({
  count: z.int(),
  deletedIds: z.array(id),
  deletedKeys: z.array(z.string()),
});
