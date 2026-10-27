import { withFieldEnvelopes } from "./field-envelope";
import {
  imageFieldEnvelopeFields,
  imagePublicReadFields,
} from "./generated/entity-field-envelope-fields.image.gen";
import { imageFieldEnvelopeSchemas } from "./generated/entity-field-envelopes.image.gen";
import {
  imageProcessingIssue,
  imageAssociationEntity,
  imageAssociationRole,
} from "./image-processing";
import { imageAssociationStorage } from "./entity-definitions/image-associations";
import { parseShortcode } from "@cubby/shared";
import { IMAGE_FIELD_KEYS } from "./image-field-keys";
import { productImagePurpose } from "./image-summary";
import { imageAttachmentReadSchema as imageOut } from "./generated/entity-image-attachment.gen";
import { z } from "zod";
import {
  ALLOWED_IMAGE_TYPES,
  type AllowedImageType,
} from "@cubby/shared/image-types";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { nonEmptyTuple } from "./identifiers";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import { entityFilterList, oneOrMany, presenceFilter } from "./pagination";
import { auditDateFilterFields } from "./base-entity";
import { imageCaptureLocation } from "./image-capture-fields";
import { imageSightingCamera } from "./image-sighting-fields";
import { purchaseDocumentKind } from "./purchase";
import { runTargetState } from "./purchase-import";
import {
  coverEntities,
  galleryEntities,
  logoEntities,
  type ShortcodeEntity,
} from "./entity-manifest";
import { anyShortcodeSchema } from "./identifiers";
import { entityImage } from "./entity";
import {
  id,
  imageShortcode,
  runShortcode,
  productShortcode,
  projectShortcode,
} from "./identifiers";
import {
  generatedImageFieldSchemas,
  generatedImageFilterFields,
  generatedImageRenderStatusValues,
  generatedImageStatusValues,
  generatedImageStorageStatusValues,
} from "./generated/entity-field-schemas.image.gen";

export const ImageStatus = generatedImageFieldSchemas.read.status;
export const imageStatusValues = generatedImageStatusValues;
export type ImageStatus = z.infer<typeof ImageStatus>;

// These values describe bytes and storage independently of the browser upload
// lifecycle above.  Keeping them nullable on Image makes this an expand-only
// change for pre-existing and presigned-upload rows.
export const ImageRenderStatus =
  generatedImageFieldSchemas.read.renderStatus.unwrap();
export const ImageStorageStatus =
  generatedImageFieldSchemas.read.storageStatus.unwrap();
export const imageRenderStatusValues = generatedImageRenderStatusValues;
export const imageStorageStatusValues = generatedImageStorageStatusValues;
export type ImageRenderStatus = z.infer<typeof ImageRenderStatus>;
export type ImageStorageStatus = z.infer<typeof ImageStorageStatus>;

/** Durable current-image processing findings exposed to list and Problems. */
export { imageProcessingIssue } from "./image-processing";
export type ImageProcessingIssue = z.infer<typeof imageProcessingIssue>;
export const imageProcessingIssueFilter = oneOrMany(imageProcessingIssue)
  .optional()
  .describe(
    "Filter to images whose current processing failed or needs eligibility review.",
  );

export type ImageSortField = GeneratedEntitySortField<"image">;

export { ALLOWED_IMAGE_TYPES, type AllowedImageType };
const imageContentType = z.enum(ALLOWED_IMAGE_TYPES);

export const perceptualHashSchema = z.string().regex(/^[0-9a-f]{16}$/);
export const imageSourceFingerprintSchema = z.object({
  hash: perceptualHashSchema,
  aspectRatio: z.number().positive().finite(),
});
export type ImageSourceFingerprint = z.infer<
  typeof imageSourceFingerprintSchema
>;

/**
 * Bumps to invalidate every stored `Image.embeddedMetadata` row and the
 * `metadataRevision` stale marker that guards it, forcing the
 * `image-metadata.extract` background task to re-read and re-parse every
 * image's bytes (see `image-metadata-revision.service.ts`).
 */
export const IMAGE_METADATA_REVISION = 1;

/**
 * The storage/wire shape of embedded EXIF/GPS metadata cached on
 * `Image.embeddedMetadata`. `capturedAt` is an ISO string — jsonb has no
 * native Date type, so the background task (`image-metadata.ts`'s parser
 * returns a `Date`) converts at the storage boundary, and
 * `image-capture-derivation.ts` converts back when it reads this column as
 * `DeriveImageCaptureExif`.
 */
export const storedImageEmbeddedMetadataSchema = z.object({
  capturedAt: z.iso.datetime().nullable(),
  capturedAtOffsetMinutes: z.number().int().nullable(),
  location: imageCaptureLocation.nullable(),
  camera: imageSightingCamera.nullable(),
  orientation: z.number().int().nullable(),
});
export type StoredImageEmbeddedMetadata = z.infer<
  typeof storedImageEmbeddedMetadataSchema
>;

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

/** The minimum shape the displayability predicate reads. Named so cascade
 *  helpers can constrain their generics to exactly what they forward. */
export type DisplayableFile = {
  contentType: string;
  renderStatus?: ImageRenderStatus | null;
  storageStatus?: ImageStorageStatus | null;
};

/** Excluded values are shared by in-memory filtering and repository SQL. */
export const imageDisplayabilityExclusions = [
  { field: "contentType", values: [PDF_CONTENT_TYPE] },
  { field: "renderStatus", values: ["failed"] },
  { field: "storageStatus", values: ["missing", "metadata_mismatch"] },
] satisfies readonly {
  field: keyof DisplayableFile;
  values: readonly string[];
}[];

export const isDisplayableImageFile = (file: DisplayableFile): boolean =>
  imageDisplayabilityExclusions.every(
    ({ field, values }) => !values.some((value) => file[field] === value),
  );

export type PartitionedEntityFiles<T> = { images: T[]; documents: T[] };

export const partitionEntityFiles = <T extends { contentType: string }>(
  files: T[],
): PartitionedEntityFiles<T> => ({
  images: files.filter(isDisplayableImageFile),
  documents: files.filter(isDocumentFile),
});

export const createInputImages = z.object({
  pendingImageIds: z.array(imageShortcode).optional(),
});

export const updateInputImages = z.object({
  // All three are public `IMG-` codes now that `Image` mints a shortcode at
  // insert time: `pendingImageIds` comes back from `image.create_file_upload`/
  // `image.uploadImage`/`importImageFromUrl`, `removeImageIds`/`imageOrder`
  // from `ImageOut`. Every one has to be resolved to a uuid (via
  // `resolveAllPresent`) before it reaches a join-table write.
  pendingImageIds: z.array(imageShortcode).optional(),
  removeImageIds: z.array(imageShortcode).optional(),
  imageOrder: z.array(imageShortcode).optional(),
});

// A key added to one list and not the other fails to compile here.
type ImageFieldKey = (typeof IMAGE_FIELD_KEYS)[number];
({}) satisfies Record<
  Exclude<keyof typeof updateInputImages.shape, ImageFieldKey>,
  never
>;
({}) satisfies Record<
  Exclude<ImageFieldKey, keyof typeof updateInputImages.shape>,
  never
>;

export type UpdateInputImages = z.infer<typeof updateInputImages>;

// Max image upload size (~50MB) — server refuses presigned URLs for absurd sizes.
export const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024;

const initiateUploadFields = {
  filename: z.string(),
  size: z.int().positive().max(MAX_IMAGE_UPLOAD_BYTES),
  entityKind: entityImage.optional(),
  source: generatedImageFieldSchemas.update.source,
  sourcePageUrl: generatedImageFieldSchemas.update.sourcePageUrl,
  sourceAssetUrl: generatedImageFieldSchemas.update.sourceAssetUrl,
  sourceName: generatedImageFieldSchemas.update.sourceName,
};

export const initiateUploadWithoutEntitySchema = z.object({
  ...initiateUploadFields,
  contentType: imageContentType,
  algorithmRevision: z.literal(1).optional(),
  perceptualHash: perceptualHashSchema.optional(),
  sourceFingerprint: imageSourceFingerprintSchema.optional(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
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
  id: imageShortcode,
});

// Input for renaming an image. `filename` is the only safely user-editable
// column — key/url/size/contentType/status are all derived (see the repo
// comment on `updateImage`).
export const imageUpdateInput = z.object(generatedImageFieldSchemas.update);
export type ImageUpdateInput = z.infer<typeof imageUpdateInput>;

// Filters accepted by the image list endpoint (filters-only, matching every
// other *FiltersSchema — the crud factory owns sort/pagination).
export const imageFilterFields = {
  ...auditDateFilterFields,
  ...generatedImageFilterFields,
  processingIssue: imageProcessingIssueFilter,
  referencePresenceFilter: presenceFilter.describe(
    "Filter to images that are or are not referenced by any owning entity.",
  ),
  runId: entityFilterList(runShortcode)
    .optional()
    .describe(
      "Only images that are a target of one of these import runs. Sets list order to the run's capture order (capturedAt, undated last, then importTarget.position) instead of the default sort.",
    ),
  targetState: oneOrMany(runTargetState)
    .optional()
    .describe("Only images whose import-run target is in one of these states."),
};

export const imageListFiltersSchema = z.object(imageFilterFields);
export type ImageListFilters = z.infer<typeof imageListFiltersSchema>;

export const importImageFromUrlSchema = z.object({
  url: z.url(),
  entityKind: entityImage.optional(),
});

// All declared direct-image targets share the attachment API. Singular roles
// replace the current attachment; gallery attachments append.
export const attachableImageEntity = imageAssociationEntity;
export const attachmentRoleForEntity = (
  entity: z.infer<typeof attachableImageEntity>,
) => {
  const storage = imageAssociationStorage.shape[entity].value;
  return storage === "gallery" ? "attachment" : storage;
};

export const validateAttachmentRole = (
  entityId: string,
  role: z.infer<typeof imageAssociationRole> | undefined,
  ctx: z.RefinementCtx,
) => {
  const entity = attachableImageEntity.safeParse(
    parseShortcode(entityId)?.type,
  );
  if (!entity.success) return;
  const expected = attachmentRoleForEntity(entity.data);
  if ((role ?? "attachment") !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["role"],
      message: `Use role "${expected}" for ${entity.data} attachments`,
    });
  }
};
export type AttachableImageEntity = z.infer<typeof attachableImageEntity>;

export { productImagePurpose } from "./image-summary";
export type ProductImagePurpose = z.infer<typeof productImagePurpose>;

const attachableImageEntities = nonEmptyTuple<ShortcodeEntity>(
  attachableImageEntity.options,
);
export const attachableImageEntityId = anyShortcodeSchema(
  attachableImageEntities,
);

export const imageAttachExistingInput = z
  .object({
    imageId: imageShortcode.describe("Existing uploaded image shortcode"),
    targetId: attachableImageEntityId.describe(
      "Shortcode of a live image-bearing record",
    ),
    role: imageAssociationRole
      .optional()
      .describe(
        "Defaults to attachment for galleries. Specify cover or logo to replace a singular image.",
      ),
    sortOrder: z.number().int().nonnegative().optional(),
    purpose: productImagePurpose.optional(),
  })
  .superRefine((value, ctx) => {
    validateAttachmentRole(value.targetId, value.role, ctx);
    if (
      value.role &&
      value.role !== "attachment" &&
      value.sortOrder !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sortOrder"],
        message: "sortOrder is only supported for gallery attachments",
      });
    }
    if (
      value.purpose !== undefined &&
      !productShortcode.safeParse(value.targetId).success
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "purpose is only supported for Product attachments",
      });
    }
  });
export type ImageAttachExistingInput = z.infer<typeof imageAttachExistingInput>;

export const imageAttachExistingOutput = z.object({
  imageId: imageShortcode,
  targetId: attachableImageEntityId,
  reused: z.boolean(),
});
export type ImageAttachExistingOutput = z.infer<
  typeof imageAttachExistingOutput
>;

// Field map (not a z.object) so the MCP tool can consume `.shape` directly; the
// cross-field "exactly one of url/data/uploadId" rule — which JSON Schema can't
// express — lives in `mcpAttachFileInput`'s refine at the workflow boundary.
export const attachFileFields = {
  entityKind: attachableImageEntity.describe(
    "Target entity type to attach the file to",
  ),
  entityId: attachableImageEntityId.describe("Shortcode of the target entity"),
  role: imageAssociationRole
    .optional()
    .describe(
      "Defaults to attachment for galleries. Specify cover or logo to replace a singular image after validation succeeds.",
    ),
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
      "Base64-encoded file bytes, optionally a `data:<type>;base64,...` URI. Provide exactly one of `url`, `data`, or `uploadId`. Unusable at photo sizes — stage the file with image.create_file_upload instead.",
    ),
  uploadId: imageShortcode
    .optional()
    .describe(
      "`IMG-` code from image.create_file_upload, after the presigned PUT succeeded. This is the route for a file on local disk: neither `url` nor `data` can carry one. Provide exactly one of `url`, `data`, or `uploadId`.",
    ),
  contentType: z
    .string()
    .optional()
    .describe(
      "MIME type (image/jpeg, image/png, image/gif, image/webp, image/avif, image/heic, image/heif, or application/pdf). application/octet-stream is resolved from supported file bytes before attachment. Required for base64 `data` unless a data: URI carries it; inferred from the response for `url`.",
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
      "Optional current attachment count for Products (including labels and documents), or displayable-image count for other records; attachment fails if it has changed.",
    ),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  expectedBytes: z.int().positive().max(MAX_IMAGE_UPLOAD_BYTES).optional(),
  purpose: productImagePurpose
    .optional()
    .describe(
      "Product-only attachment role. Labels remain attached but do not supply covers.",
    ),
  source: generatedImageFieldSchemas.update.source,
  sourcePageUrl: generatedImageFieldSchemas.update.sourcePageUrl,
  sourceAssetUrl: generatedImageFieldSchemas.update.sourceAssetUrl,
  sourceName: generatedImageFieldSchemas.update.sourceName,
};

export const mcpAttachFileInput = z
  .strictObject(attachFileFields)
  .superRefine((value, ctx) => {
    validateAttachmentRole(value.entityId, value.role, ctx);
    const targetKind = parseShortcode(value.entityId)?.type;
    if (targetKind !== value.entityKind) {
      ctx.addIssue({
        code: "custom",
        path: ["entityKind"],
        message: "entityKind must match entityId",
      });
    }
    const sources = [value.url, value.data, value.uploadId].filter(Boolean);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of `url`, `data`, or `uploadId`",
      });
    }
    if (value.entityKind === "purchase" && value.documentKind === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["documentKind"],
        message: "documentKind is required for Purchase attachments",
      });
    }
    if (value.purpose !== undefined && value.entityKind !== "product") {
      ctx.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "purpose is only supported for Product attachments",
      });
    }
  });
export type McpAttachFileInput = z.infer<typeof mcpAttachFileInput>;

export const attachFileResponse = z.object({
  // The public code, so a caller can feed it straight back into `removeImageIds`
  // or `imageOrder`. Returning a uuid here made that round trip impossible.
  imageId: imageShortcode,
  url: z.url(),
  filename: z.string(),
  contentType: z.string(),
  kind: z.enum(["image", "document"]),
  entityKind: attachableImageEntity,
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
  cleanupWarning: z.string().optional(),
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
 * straight to R2 and hands `image.attach_file` the id.
 */
export const createFileUploadInput = z.object({
  entityId: attachableImageEntityId.describe(
    "Shortcode of the entity the file will be attached to. Only used to file the object readably; the attachment itself happens in image.attach_file.",
  ),
  filename: z.string().min(1).describe("Filename, including its extension."),
  contentType: z
    .string()
    .describe(
      "MIME type (image/jpeg, image/png, image/gif, image/webp, image/avif, image/heic, image/heif, or application/pdf). application/octet-stream may stage unknown files; attachment validates supported file bytes and stores the detected type. Must match the Content-Type header sent on the PUT.",
    ),
  size: z
    .int()
    .positive()
    .describe(
      "Byte size of the file. Recorded on the staged row; the real size is measured again when image.attach_file reads the object back.",
    ),
});
export type CreateFileUploadInput = z.infer<typeof createFileUploadInput>;

export const createFileUploadResponse = z.object({
  // The staged row's public `IMG-` code, not its uuid: `Image` mints a
  // shortcode at insert time like every other entity, and a raw uuid never
  // crosses this API.
  uploadId: imageShortcode.describe(
    "`IMG-` code of the staged row. Pass to image.attach_file as `uploadId` once the PUT succeeds.",
  ),
  uploadUrl: z
    .url()
    .describe(
      "Presigned PUT URL. Upload with the same contentType you declared, e.g. `curl -X PUT -H 'Content-Type: <type>' --upload-file <path> '<uploadUrl>'`.",
    ),
});
export type CreateFileUploadResponse = z.infer<typeof createFileUploadResponse>;

export const CULL_PENDING_IMAGES_DEFAULT_HOURS = 24;

export const cullPendingImagesSchema = z.object({
  olderThanHours: z.int().positive().default(CULL_PENDING_IMAGES_DEFAULT_HOURS),
});

export {
  imageAnalysisSummarySchema,
  type ImageAnalysisSummary,
} from "./entity-definitions/field-primitives";

export { imageOut };
export type ImageOut = z.infer<typeof imageOut>;

export const imageHashIndexItemSchema = z.object({
  id: imageShortcode,
  perceptualHash: perceptualHashSchema.nullable(),
  sourceFingerprint: imageSourceFingerprintSchema.nullable(),
  width: generatedImageFieldSchemas.read.width,
  height: generatedImageFieldSchemas.read.height,
  directOwnerShortcodes: z.array(
    anyShortcodeSchema(
      nonEmptyTuple<ShortcodeEntity>([
        ...galleryEntities,
        ...coverEntities,
        ...logoEntities,
      ]),
    ),
  ),
});
export const imageHashIndexSchema = z.object({
  algorithmRevision: z.literal(1),
  items: z.array(imageHashIndexItemSchema),
  repair: z.array(
    z.object({
      id: imageShortcode,
      originalUrl: z
        .url()
        .describe(
          "Original stored bytes to hash for index repair; never the selected display representation.",
        ),
    }),
  ),
});
export type ImageHashIndex = z.infer<typeof imageHashIndexSchema>;

export const imagePerceptualHash = z.object({
  id: imageShortcode,
  perceptualHash: perceptualHashSchema,
});

export const setPerceptualHashesInputSchema = z.object({
  algorithmRevision: z.literal(1),
  items: z.array(imagePerceptualHash).max(50),
});
export const setPerceptualHashesOutputSchema = z.object({
  items: z.array(imagePerceptualHash),
  unavailable: z.array(imageShortcode),
});
export type SetPerceptualHashesInput = z.infer<
  typeof setPerceptualHashesInputSchema
>;
export type SetPerceptualHashesOutput = z.infer<
  typeof setPerceptualHashesOutputSchema
>;

// Every direct-image entity, derived from the manifest for the same reason
// `attachableImageEntity` is. Gallery, cover, and logo storage modes are all
// authoritative association targets.
export {
  imageAssociationEntity,
  imageAssociationRole,
  imageAssociationSchema,
  type ImageAssociation,
} from "./image-processing";
export const initiateUploadWithoutEntityResponseSchema = z.object({
  uploadUrl: z.url(),
  // The public `IMG-` code: `Image` mints a shortcode at insert time
  // (`insertWithShortcode`) like every other entity, so there is no longer a
  // raw-uuid form to hand back here. Its destination, `pendingImageIds`, is a
  // shortcode field for the same reason — see the note there.
  imageId: imageShortcode,
  key: z.string(),
  url: z.url(),
});

/** An Image's current row in a photo-inventory (or other) import run's picker. */
export {
  importTargetSummarySchema,
  type ImportTargetSummary,
} from "./image-processing";
export const imageWithEntitySchema = imageFieldEnvelopeSchemas.detail;

export type ImageWithEntity = z.infer<typeof imageWithEntitySchema>;

export const imageBrowserUpdateInput = z.object({
  id: imageShortcode,
  data: imageUpdateInput,
});

export const imageBrowserDeleteInput = z.object({
  ids: z.array(imageShortcode).min(1).max(500),
});
export const imageBrowserDeleteOut = z.object({
  deleted: z.number().int().nonnegative(),
  sideEffects: mutationSideEffectsSchema,
});

export const projectImageSummarySchema = withFieldEnvelopes(
  z
    .object(generatedImageFieldSchemas.read)
    .pick({ id: true, url: true, filename: true }),
  imageFieldEnvelopeFields,
  imagePublicReadFields,
);
export const projectImageSummariesInput = z.object({
  projectIds: z.array(projectShortcode).max(500),
});
export const projectImageSummariesOut = z.record(
  projectShortcode,
  z.array(projectImageSummarySchema),
);

export const importImageFromUrlResponseSchema = z.object({
  imageId: imageShortcode,
  key: z.string(),
  url: z.url(),
  filename: z.string(),
});

export const cullPendingImagesResponseSchema = z.object({
  count: z.int().nonnegative(),
  deletedIds: z.array(id),
  deletedKeys: z.array(z.string()),
});
