import {
  attachableImageEntity,
  attachFileFields,
  attachFileResponse,
  createFileUploadInput,
  createFileUploadResponse,
  cullPendingImagesResponseSchema,
  cullPendingImagesSchema,
  getImageByIdSchema,
  imageWithEntitySchema,
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
export const attachFileItem = z
  .object({
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

export const imageUploadContract = defineContract("image", {
  markUploaded: mutation({
    native: "PhotoService",
    input: getImageByIdSchema,
    output: imageWithEntitySchema,
  }),
  uploadImage: mutation({
    native: "PhotoService",
    input: initiateUploadWithoutEntitySchema,
    output: initiateUploadWithoutEntityResponseSchema,
  }),
  uploadDocument: mutation({
    native: "Purchase import receipt evidence",
    input: initiateDocumentUploadSchema,
    output: initiateUploadWithoutEntityResponseSchema,
  }),
  importFromUrl: mutation({
    input: importImageFromUrlSchema,
    output: importImageFromUrlResponseSchema,
    invalidates: ["image"],
  }),
  cullPendingImages: mutation({
    input: cullPendingImagesSchema,
    output: cullPendingImagesResponseSchema,
    invalidates: ["imageCull"],
  }),
  // Agent-facing (MCP `image`, batched per item): off the HTTP API.
  /** Stage one local file and presign its PUT. */
  createFileUpload: mutation({
    http: false,
    input: createFileUploadInput,
    output: createFileUploadResponse,
  }),
  /** Attach one file by URL or staged upload to the entity its shortcode names. */
  attachFile: mutation({
    http: false,
    input: attachFileItem,
    output: attachFileResponse,
    invalidates: ["image"],
  }),
});
