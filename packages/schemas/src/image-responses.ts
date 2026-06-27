import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { entityImage } from "./entity";
import { ImageStatus } from "./image";
import { id } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";

// Schema for image output (response)
export const imageOut = z
  .object({
    id: id,
    url: z.url(),
    key: z.string(),
    filename: z.string(),
    size: z.int().positive(),
    contentType: z.string(),
    status: ImageStatus,
  })
  .extend(dbTimestampsOut.shape);

export type ImageOut = z.infer<typeof imageOut>;

// Response for initiating an upload without entity ID
export const initiateUploadWithoutEntityResponseSchema = z.object({
  uploadUrl: z.url(),
  imageId: id,
  key: z.string(),
  url: z.url(),
});

// Image with entity information
export const imageWithEntitySchema = imageOut.extend({
  entityType: entityImage.nullable(),
  entityId: id.nullable(),
  entityName: z.string().nullable(),
});

export type ImageWithEntity = z.infer<typeof imageWithEntitySchema>;

// New response schema using the standard paginated response format
export const imageListResponseSchema = createPaginatedResponseSchema(
  imageWithEntitySchema,
);

// Response schema for importing an image from a URL
export const importImageFromUrlResponseSchema = z.object({
  imageId: id,
  key: z.string(),
  url: z.url(),
  filename: z.string(),
});

// Response schema for culling pending images
export const cullPendingImagesResponseSchema = z.object({
  count: z.int(),
  deletedIds: z.array(id),
  deletedKeys: z.array(z.string()),
});
