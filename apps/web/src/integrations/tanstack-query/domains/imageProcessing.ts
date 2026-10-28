import { imageProcessingContract } from "~/contracts/image-processing.contract";

import { defineOperationDomain } from "../operation-catalog";

export const imageProcessing = /* @__PURE__ */ defineOperationDomain(
  imageProcessingContract,
);
