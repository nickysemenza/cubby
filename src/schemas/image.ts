import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { id } from "./identifiers";
import {
  sortPaginationCombo,
  createPaginatedResponseSchema,
} from "./pagination";
import { entityImage } from "~/entities/types";

// Image status enum
export const ImageStatus = z.enum(["PENDING", "UPLOADED", "FAILED"]);
export type ImageStatus = z.infer<typeof ImageStatus>;

// Base schema for image data
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

// Schema for initiating an image upload without entity ID (for pending uploads)
export const initiateUploadWithoutEntitySchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  size: z.int().positive(),
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

// Schema for culling pending images
export const cullPendingImagesSchema = z.object({
  olderThanHours: z.int().positive().prefault(24),
});

// Response schema for culling pending images
export const cullPendingImagesResponseSchema = z.object({
  count: z.int(),
  deletedIds: z.array(id),
  deletedKeys: z.array(z.string()),
});
