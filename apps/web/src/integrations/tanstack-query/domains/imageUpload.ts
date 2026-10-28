import { imageUploadContract } from "~/contracts/image-upload.contract";

import { defineOperationDomain } from "../operation-catalog";

export const imageUpload =
  /* @__PURE__ */ defineOperationDomain(imageUploadContract);
