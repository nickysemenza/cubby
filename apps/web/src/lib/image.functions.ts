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
  }),
  cullPendingImages: mutation({
    input: cullPendingImagesSchema,
    output: cullPendingImagesResponseSchema,
  }),
  cleanupUnreferencedImages: mutation({
    input: z.undefined(),
    output: cullPendingImagesResponseSchema,
  }),
});
