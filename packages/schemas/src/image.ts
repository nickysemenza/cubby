import { z } from "zod";
import { oneOrMany, presenceFilter } from "./pagination";
import { auditDateFilterFields } from "./base-entity";
import { purchaseDocumentKind } from "./purchase";
import type { ShortcodeEntity } from "./entity-manifest";
import { anyShortcodeSchema } from "./identifiers";
import { entityImage } from "./entity";
import { id } from "./identifiers";

// Image status values - single source of truth for both Zod and Drizzle
export const imageStatusValues = ["PENDING", "UPLOADED", "FAILED"] as const;

export const ImageStatus = z.enum(imageStatusValues);
export type ImageStatus = z.infer<typeof ImageStatus>;

// These values describe bytes and storage independently of the browser upload
// lifecycle above.  Keeping them nullable on Image makes this an expand-only
// change for pre-existing and presigned-upload rows.
export const imageRenderStatusValues = [
  "unverified",
  "verified",
  "failed",
] as const;
export const imageStorageStatusValues = [
  "unverified",
  "available",
  "missing",
  "metadata_mismatch",
] as const;
export const ImageRenderStatus = z.enum(imageRenderStatusValues);
export const ImageStorageStatus = z.enum(imageStorageStatusValues);
export type ImageRenderStatus = z.infer<typeof ImageRenderStatus>;
export type ImageStorageStatus = z.infer<typeof ImageStorageStatus>;

export const imageSortableFields = [
  "createdAt",
  "updatedAt",
  "filename",
  "size",
  "status",
] as const;

export type ImageSortField = (typeof imageSortableFields)[number];

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

export const isDisplayableImageFile = (file: {
  contentType: string;
  renderStatus?: ImageRenderStatus | null;
  storageStatus?: ImageStorageStatus | null;
}): boolean =>
  !isDocumentFile(file) &&
  file.renderStatus !== "failed" &&
  file.storageStatus !== "missing" &&
  file.storageStatus !== "metadata_mismatch";

export const partitionEntityFiles = <T extends { contentType: string }>(
  files: T[],
): { images: T[]; documents: T[] } => ({
  images: files.filter(isDisplayableImageFile),
  documents: files.filter(isDocumentFile),
});

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
// `entityType` is optional: every entity-form caller still passes it, but a
// standalone `/images` upload has no owning entity yet at initiate time.
const initiateUploadFields = {
  filename: z.string(),
  size: z.int().positive().max(MAX_IMAGE_UPLOAD_BYTES),
  entityType: entityImage.optional(),
};

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

export const getImageByIdSchema = z.object({
  id: id,
});

// Input for renaming an image. `filename` is the only safely user-editable
// column — key/url/size/contentType/status are all derived (see the repo
// comment on `updateImage`).
export const imageUpdateInput = z.object({
  filename: z.string().trim().min(1).max(255),
});
export type ImageUpdateInput = z.infer<typeof imageUpdateInput>;

// Filters accepted by the image list endpoint (filters-only, matching every
// other *FiltersSchema — the crud factory owns sort/pagination).
export const imageFilterFields = {
  ...auditDateFilterFields,
  nameFilter: z.string().optional().describe("Filter by filename (substring)"),
  status: oneOrMany(ImageStatus).optional().describe("Filter by upload status"),
  referencePresenceFilter: presenceFilter.describe(
    "Filter to images that are or are not referenced by any owning entity.",
  ),
  uploadedAgeHoursMin: z.coerce
    .number()
    .positive()
    .max(24 * 365 * 10)
    .optional()
    .describe("Only images uploaded more than this many hours ago."),
};

export const imageListFiltersSchema = z.object(imageFilterFields);
export type ImageListFilters = z.infer<typeof imageListFiltersSchema>;

export const importImageFromUrlSchema = z.object({
  url: z.url(),
  entityType: entityImage.optional(),
});

// The image-bearing entities exposed as attach targets. A subset of
// `entityImage` (uppercase storage keys) — cookbook is excluded because it uses
// a single write-once `coverImageId` (replace, not append), unlike these five
// gallery join tables. Lowercase to match the `entitySchema` slug convention the
// rest of the MCP surface uses; mapped to the join dispatch server-side.
export const attachableImageEntity = z.enum([
  "product",
  "recipe",
  "location",
  "project",
  // The point of `PurchaseImage`: filing the metal store's emailed PDF invoice
  // against the charge it documents.
  "purchase",
]);
export type AttachableImageEntity = z.infer<typeof attachableImageEntity>;

const attachableImageEntities = attachableImageEntity.options as unknown as [
  ShortcodeEntity,
  ...ShortcodeEntity[],
];
export const attachableImageEntityId = anyShortcodeSchema(
  attachableImageEntities,
);

// Field map (not a z.object) so the MCP tool can consume `.shape` directly; the
// cross-field "exactly one of url/data/uploadId" rule — which JSON Schema can't
// express — lives in `mcpAttachFileInput`'s refine (used by the tRPC procedure).
export const attachFileFields = {
  entityType: attachableImageEntity.describe(
    "Target entity type to attach the file to",
  ),
  entityId: attachableImageEntityId.describe("Shortcode of the target entity"),
  url: z
    .url()
    .optional()
    .describe(
      "External http(s) URL to fetch the file from. Provide exactly one of `url`, `data`, or `uploadId`.",
    ),
  data: z
    .string()
    .optional()
    .describe(
      "Base64-encoded file bytes, optionally a `data:<type>;base64,...` URI. Provide exactly one of `url`, `data`, or `uploadId`. Unusable at photo sizes — stage the file with create_file_upload instead.",
    ),
  uploadId: id
    .optional()
    .describe(
      "Id from create_file_upload, after the presigned PUT succeeded. This is the route for a file on local disk: neither `url` nor `data` can carry one. Provide exactly one of `url`, `data`, or `uploadId`.",
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
  documentKind: purchaseDocumentKind
    .optional()
    .describe(
      "Required when entityId is a PUR- Purchase shortcode; classifies the attached purchase evidence.",
    ),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Optional stable key: repeating it for the same target returns the original attachment, as long as that attachment still exists. If the file was detached in between, the retry uploads again and `reused` comes back false.",
    ),
  expectedImageCount: z
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Optional current displayable-image count; attachment fails if it has changed.",
    ),
};

export const mcpAttachFileInput = z
  .object(attachFileFields)
  .superRefine((value, ctx) => {
    const sources = [value.url, value.data, value.uploadId].filter(Boolean);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of `url`, `data`, or `uploadId`",
      });
    }
    if (value.entityType === "purchase" && value.documentKind === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["documentKind"],
        message: "documentKind is required for Purchase attachments",
      });
    }
  });
export type McpAttachFileInput = z.infer<typeof mcpAttachFileInput>;

export const attachFileResponse = z.object({
  imageId: id,
  url: z.url(),
  filename: z.string(),
  contentType: z.string(),
  kind: z.enum(["image", "document"]),
  entityType: attachableImageEntity,
  entityId: attachableImageEntityId,
  idempotencyKey: z.string().nullable().optional(),
  /**
   * Required, not optional, so both return paths in `attachFileToEntity` have
   * to state which one they took — the whole point is that a caller could not
   * previously tell a replay from an upload.
   */
  reused: z
    .boolean()
    .describe(
      "True when idempotencyKey matched a still-attached file and nothing was uploaded. False on a real attach — including a repeat of a key whose file was detached in between.",
    ),
});
export type AttachFileResponse = z.infer<typeof attachFileResponse>;

/**
 * Stage a local file for attachment.
 *
 * A file on disk cannot reach the server any other way. The MCP server is a
 * remote Worker, so `url` cannot name a local path (and `validateExternalHttpUrl`
 * blocks `file://`, localhost, and private IPs as an SSRF guard), while `data`
 * costs ~82k tokens for a single photo. The browser has always had a two-phase
 * presigned flow for exactly this; this exposes it, so the client PUTs the bytes
 * straight to R2 and hands `attach_file` the id.
 */
export const createFileUploadInput = z.object({
  entityId: attachableImageEntityId.describe(
    "Shortcode of the entity the file will be attached to. Only used to file the object readably; the attachment itself happens in attach_file.",
  ),
  filename: z.string().min(1).describe("Filename, including its extension."),
  contentType: z
    .string()
    .describe(
      "MIME type (image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, or application/pdf). Must match the Content-Type header sent on the PUT.",
    ),
  size: z
    .int()
    .positive()
    .describe(
      "Byte size of the file. Recorded on the staged row; the real size is measured again when attach_file reads the object back.",
    ),
});
export type CreateFileUploadInput = z.infer<typeof createFileUploadInput>;

export const createFileUploadResponse = z.object({
  uploadId: id.describe(
    "Pass to attach_file as `uploadId` once the PUT succeeds.",
  ),
  uploadUrl: z
    .url()
    .describe(
      "Presigned PUT URL. Upload with the same contentType you declared, e.g. `curl -X PUT -H 'Content-Type: <type>' --upload-file <path> '<uploadUrl>'`.",
    ),
});
export type CreateFileUploadResponse = z.infer<typeof createFileUploadResponse>;

/**
 * Age threshold (hours) past which an unassociated PENDING image counts as an
 * abandoned upload. Shared by the cull mutation's default and the Maintenance
 * card's "N affected" count, so the number shown and the number deleted match.
 */
export const CULL_PENDING_IMAGES_DEFAULT_HOURS = 24;

export const cullPendingImagesSchema = z.object({
  olderThanHours: z.int().positive().default(CULL_PENDING_IMAGES_DEFAULT_HOURS),
});

export const imageOut = z.object({
  id: id,
  url: z.url(),
  key: z.string(),
  filename: z.string(),
  size: z.int().positive(),
  contentType: z.string(),
  status: ImageStatus,
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  detectedContentType: z.string().nullable(),
  sha256: z.string().nullable(),
  renderStatus: ImageRenderStatus.nullable(),
  storageStatus: ImageStorageStatus.nullable(),
  verifiedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ImageOut = z.infer<typeof imageOut>;

export const initiateUploadWithoutEntityResponseSchema = z.object({
  uploadUrl: z.url(),
  imageId: id,
  key: z.string(),
  url: z.url(),
});

export const imageWithEntitySchema = z.object({
  id: id,
  url: z.url(),
  key: z.string(),
  filename: z.string(),
  size: z.int().positive(),
  contentType: z.string(),
  status: ImageStatus,
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  detectedContentType: z.string().nullable(),
  sha256: z.string().nullable(),
  renderStatus: ImageRenderStatus.nullable(),
  storageStatus: ImageStorageStatus.nullable(),
  verifiedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  entityType: entityImage.nullable(),
  entityId: attachableImageEntityId.nullable(),
  entityName: z.string().nullable(),
});

export type ImageWithEntity = z.infer<typeof imageWithEntitySchema>;

export const importImageFromUrlResponseSchema = z.object({
  imageId: id,
  key: z.string(),
  url: z.url(),
  filename: z.string(),
});

/**
 * Shared by the pending cull and the unreferenced-file sweep — both delete rows
 * and hand back the R2 keys that went with them.
 */
export const cullPendingImagesResponseSchema = z.object({
  count: z.int().nonnegative(),
  deletedIds: z.array(id),
  deletedKeys: z.array(z.string()),
});
