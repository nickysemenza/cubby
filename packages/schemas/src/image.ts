import { z } from "zod";
import { entityImage } from "./entity";
import { id } from "./identifiers";

// Image status values - single source of truth for both Zod and Drizzle
export const imageStatusValues = ["PENDING", "UPLOADED", "FAILED"] as const;

// Image status enum
export const ImageStatus = z.enum(imageStatusValues);
export type ImageStatus = z.infer<typeof ImageStatus>;

export const imageSortableFields = [
  "createdAt",
  "updatedAt",
  "filename",
  "size",
  "status",
] as const;

export type ImageSortField = (typeof imageSortableFields)[number];

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

// Documents (PDF manuals) reuse the Image table + joins; a "document" is
// inferred purely from contentType. Kept separate from ALLOWED_IMAGE_TYPES so
// image-only surfaces (paste, camera, URL import, recipe/location forms) never
// accept PDFs.
export const PDF_CONTENT_TYPE = "application/pdf";
const ALLOWED_DOCUMENT_TYPES = [PDF_CONTENT_TYPE] as const;

// Predicate must be PDF-equality, NOT `startsWith("image/")` — legacy
// same-bucket re-imports created rows with `application/octet-stream` that must
// remain displayable as images.
export const isDocumentFile = (file: { contentType: string }): boolean =>
  file.contentType === PDF_CONTENT_TYPE;

/** Split an entity's attached files into displayable images vs documents. */
export const partitionEntityFiles = <T extends { contentType: string }>(
  files: T[],
): { images: T[]; documents: T[] } => ({
  images: files.filter((f) => !isDocumentFile(f)),
  documents: files.filter(isDocumentFile),
});

// Common image input schemas for create and update operations
export const createInputImages = z.object({
  pendingImageIds: z.array(z.uuid()).optional(),
});

export const updateInputImages = z.object({
  pendingImageIds: z.array(z.uuid()).optional(),
  removeImageIds: z.array(z.uuid()).optional(),
  imageOrder: z.array(z.uuid()).optional(),
});

export type UpdateInputImages = z.infer<typeof updateInputImages>;

// Max image upload size (~50MB) — server refuses presigned URLs for absurd sizes.
export const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;

// Shared fields for upload initiation (image + document variants). Private
// field map spread into both schemas — the sanctioned pattern (no .extend).
const initiateUploadFields = {
  filename: z.string(),
  size: z.int().positive().max(MAX_IMAGE_UPLOAD_BYTES),
  entityType: entityImage,
};

// Schema for initiating an image upload without entity ID (for pending uploads)
export const initiateUploadWithoutEntitySchema = z.object({
  ...initiateUploadFields,
  contentType: imageContentType,
});

export type InitiateUploadWithoutEntityInput = z.infer<
  typeof initiateUploadWithoutEntitySchema
>;

// Document (PDF) upload initiation. `folder` groups the object under a
// human-meaningful R2 prefix (the owning entity's shortcode, e.g. "P-0123") so
// document URLs read as .../documents/P-0123/blender-manual.pdf. Optional —
// create-mode forms have no shortcode yet.
export const initiateDocumentUploadSchema = z.object({
  ...initiateUploadFields,
  contentType: z.enum(ALLOWED_DOCUMENT_TYPES),
  folder: z.string().max(64).optional(),
});

export type InitiateDocumentUploadInput = z.infer<
  typeof initiateDocumentUploadSchema
>;

// Schema for getting image by ID
export const getImageByIdSchema = z.object({
  id: id,
});

// Filters accepted by the image list endpoint (filters-only, matching every
// other *FiltersSchema — the crud factory owns sort/pagination).
export const imageFilterFields = {
  nameFilter: z.string().optional().describe("Filter by filename (substring)"),
};

export const imageListFiltersSchema = z.object(imageFilterFields);

// Schema for importing an image from a URL
export const importImageFromUrlSchema = z.object({
  url: z.url(),
  entityType: entityImage,
});

// --- MCP attach_file ---------------------------------------------------------

// The image-bearing entities exposed as attach targets. A subset of
// `entityImage` (uppercase storage keys) — cookbook is excluded because it uses
// a single write-once `coverImageId` (replace, not append), unlike these four
// gallery join tables. Lowercase to match the `entitySchema` slug convention the
// rest of the MCP surface uses; mapped to the join dispatch server-side.
export const attachableImageEntity = z.enum([
  "product",
  "recipe",
  "location",
  "project",
]);
export type AttachableImageEntity = z.infer<typeof attachableImageEntity>;

// Field map (not a z.object) so the MCP tool can consume `.shape` directly; the
// cross-field "exactly one of url/data" rule — which JSON Schema can't express —
// lives in `mcpAttachFileInput`'s refine (used by the tRPC procedure).
export const attachFileFields = {
  entityType: attachableImageEntity.describe(
    "Target entity type to attach the file to",
  ),
  entityId: id.describe("ID of the target entity"),
  url: z
    .url()
    .optional()
    .describe(
      "External http(s) URL to fetch the file from. Provide exactly one of `url` or `data`.",
    ),
  data: z
    .string()
    .optional()
    .describe(
      "Base64-encoded file bytes, optionally a `data:<type>;base64,...` URI. Provide exactly one of `url` or `data`.",
    ),
  contentType: z
    .string()
    .optional()
    .describe(
      "MIME type (image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, or application/pdf). Required for base64 `data` unless a data: URI carries it; inferred from the response for `url`.",
    ),
  filename: z
    .string()
    .optional()
    .describe("Optional filename for the stored object."),
};

export const mcpAttachFileInput = z
  .object(attachFileFields)
  .refine((v) => Boolean(v.url) !== Boolean(v.data), {
    message: "Provide exactly one of `url` or `data`",
  });
export type McpAttachFileInput = z.infer<typeof mcpAttachFileInput>;

export const attachFileResponse = z.object({
  imageId: id,
  url: z.url(),
  filename: z.string(),
  contentType: z.string(),
  kind: z.enum(["image", "document"]),
  entityType: attachableImageEntity,
  entityId: id,
});
export type AttachFileResponse = z.infer<typeof attachFileResponse>;

/**
 * Age threshold (hours) past which an unassociated PENDING image counts as an
 * abandoned upload. Shared by the cull mutation's default and the Maintenance
 * card's "N affected" count, so the number shown and the number deleted match.
 */
export const CULL_PENDING_IMAGES_DEFAULT_HOURS = 24;

// Schema for culling pending images
export const cullPendingImagesSchema = z.object({
  olderThanHours: z.int().positive().default(CULL_PENDING_IMAGES_DEFAULT_HOURS),
});

// Schema for image output (response)
export const imageOut = z.object({
  id: id,
  url: z.url(),
  key: z.string(),
  filename: z.string(),
  size: z.int().positive(),
  contentType: z.string(),
  status: ImageStatus,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ImageOut = z.infer<typeof imageOut>;

// Response for initiating an upload without entity ID
export const initiateUploadWithoutEntityResponseSchema = z.object({
  uploadUrl: z.url(),
  imageId: id,
  key: z.string(),
  url: z.url(),
});

// Image with entity information
export const imageWithEntitySchema = z.object({
  id: id,
  url: z.url(),
  key: z.string(),
  filename: z.string(),
  size: z.int().positive(),
  contentType: z.string(),
  status: ImageStatus,
  createdAt: z.date(),
  updatedAt: z.date(),
  entityType: entityImage.nullable(),
  entityId: id.nullable(),
  entityName: z.string().nullable(),
});

export type ImageWithEntity = z.infer<typeof imageWithEntitySchema>;

// Response schema for importing an image from a URL
export const importImageFromUrlResponseSchema = z.object({
  imageId: id,
  key: z.string(),
  url: z.url(),
  filename: z.string(),
});

// Response schema for culling pending images
export const cullPendingImagesResponseSchema = z.object({
  count: z.int().nonnegative(),
  deletedIds: z.array(id),
  deletedKeys: z.array(z.string()),
});
