import {
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
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
} from "~/integrations/tanstack-query/operation-catalog";

export const imageUpload = defineOperationDomain("image", {
  markUploaded: mutation({
    input: getImageByIdSchema,
    output: imageWithEntitySchema,
  }),
  uploadImage: mutation({
    input: initiateUploadWithoutEntitySchema,
    output: initiateUploadWithoutEntityResponseSchema,
  }),
  uploadDocument: mutation({
    input: initiateDocumentUploadSchema,
    output: initiateUploadWithoutEntityResponseSchema,
  }),
  importFromUrl: mutation({
    input: importImageFromUrlSchema,
    output: importImageFromUrlResponseSchema,
    invalidates: ripple.image,
  }),
  cullPendingImages: mutation({
    input: cullPendingImagesSchema,
    output: cullPendingImagesResponseSchema,
    invalidates: ripple.imageCull,
  }),
  cleanupUnreferencedImages: mutation({
    input: z.undefined(),
    output: cullPendingImagesResponseSchema,
    invalidates: ripple.imageCull,
  }),
});
