import { imageDetailOut as imageWithEntitySchema } from "@cubby/schemas/entities/image";
import {
  attachableImageEntity,
  validateAttachmentRole,
  attachFileFields,
  attachFileResponse,
  createFileUploadInput,
  createFileUploadResponse,
  cullPendingImagesResponseSchema,
  cullPendingImagesSchema,
  getImageByIdSchema,
  importImageFromUrlResponseSchema,
  importImageFromUrlSchema,
  initiateDocumentUploadSchema,
  initiateUploadWithoutEntityResponseSchema,
  initiateUploadWithoutEntitySchema,
} from "@cubby/schemas/image";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

import { defineContract, mutation } from "~/contracts/define";

// `entityKind` is derived from the shortcode's prefix, so it is not asked for.
const {
  entityKind: _entityKind,
  data: _data,
  ...attachFileEntityless
} = attachFileFields;

/** One file to attach; the target entity is named by its shortcode's prefix. */
const attachFileItem = z
  .strictObject({
    ...attachFileEntityless,
    entityId: attachFileEntityless.entityId.describe(
      `Shortcode of the target — its prefix picks the entity (${attachableImageEntity.options.join(", ")}).`,
    ),
    url: attachFileEntityless.url.describe(
      "External http(s) URL the server fetches. Provide exactly one of `url` or `uploadId`.",
    ),
    uploadId: attachFileEntityless.uploadId.describe(
      "`IMG-` code returned by image action=create_uploads after its presigned PUT succeeded. Provide exactly one of `url` or `uploadId`.",
    ),
    contentType: attachFileEntityless.contentType.describe(
      "Optional expected MIME type for a URL attachment; a conflicting response Content-Type is rejected.",
    ),
  })
  .superRefine((value, ctx) => {
    validateAttachmentRole(value.entityId, value.role, ctx);
    const sources = [value.url, value.uploadId].filter(Boolean);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of `url` or `uploadId`",
      });
    }
    if (
      value.purpose !== undefined &&
      parseShortcode(value.entityId)?.type !== "product"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "purpose is only supported for Product attachments",
      });
    }
  });

export const imageUploadContract = defineContract(
  "image",
  {
    markUploaded: mutation({
      exposure: "view",
      input: getImageByIdSchema,
      output: imageWithEntitySchema,
    }),
    uploadImage: mutation({
      exposure: "view",
      input: initiateUploadWithoutEntitySchema,
      output: initiateUploadWithoutEntityResponseSchema,
    }),
    uploadDocument: mutation({
      exposure: "view",
      input: initiateDocumentUploadSchema,
      output: initiateUploadWithoutEntityResponseSchema,
    }),
    importFromUrl: mutation({
      note: "Agents attach by URL through image.attach_file",
      input: importImageFromUrlSchema,
      output: importImageFromUrlResponseSchema,
      invalidates: ["image"],
    }),
    cullPendingImages: mutation({
      exposure: "capability",
      description:
        "Remove pending uploaded images that are no longer attached to a live target. This deletes stored uploads; call only after confirming the pending records are abandoned.",
      destructive: true,
      input: cullPendingImagesSchema,
      output: cullPendingImagesResponseSchema,
      invalidates: ["imageCull"],
    }),
    // Agent-facing (MCP `image`, batched per item).
    /** Stage one local file and presign its PUT. */
    createFileUpload: mutation({
      exposure: "capability",
      description:
        "Stage up to 50 LOCAL files (`items`) and get one presigned PUT URL per successful item — how files on disk reach Cubby, since the server is remote and `url` cannot name a local path. Three steps: call this, upload each successful item with `curl -X PUT -H 'Content-Type: <contentType>' --upload-file <path> '<uploadUrl>'`, then image.attach_file with the returned uploadIds. A failed item does not roll back successful presigns; results keep input indexes for retrying only failures. Each staged object is discarded once attached. Supported types: image/jpeg, image/png, image/gif, image/webp, image/avif, image/heic, image/heif, application/pdf.",
      input: createFileUploadInput,
      output: createFileUploadResponse,
    }),
    /** Attach one file by URL or staged upload to the entity its shortcode names. */
    attachFile: mutation({
      exposure: "capability",
      description:
        "Attach up to 50 files (`items`) in request order; each item carries its own entityId, so one call can cover many records — the cover-image pass of an enrichment sweep. Provide each file exactly one way: `url` (an http(s) link the server fetches) or `uploadId` (from image.create_file_upload — the route for a local file). A Purchase attachment requires documentKind. Provide a deterministic idempotencyKey per item so a retry of a partially-failed batch cannot double-attach, and the freshly read expectedImageCount for Product gallery writes (a mismatch is a precondition failure and attaches nothing). MIME/signature conflicts are rejected.",
      input: attachFileItem,
      output: attachFileResponse,
      invalidates: ["image"],
    }),
  },
  { exposure: "internal" },
);
