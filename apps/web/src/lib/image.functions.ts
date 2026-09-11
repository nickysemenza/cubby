import { imageUploadContract } from "~/contracts/image-upload.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const imageUpload = defineOperationDomain(imageUploadContract, {
  importFromUrl: { invalidates: ripple.image },
  cullPendingImages: { invalidates: ripple.imageCull },
  cleanupUnreferencedImages: { invalidates: ripple.imageCull },
});
