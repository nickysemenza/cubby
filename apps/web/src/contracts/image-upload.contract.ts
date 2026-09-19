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

import { defineContract, mutation } from "~/contracts/define";

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
  }),
  cullPendingImages: mutation({
    input: cullPendingImagesSchema,
    output: cullPendingImagesResponseSchema,
  }),
});
