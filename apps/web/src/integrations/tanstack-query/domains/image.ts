import { imageContract } from "~/contracts/image.contract";

import { defineOperationDomain } from "../operation-catalog";

export const image = /* @__PURE__ */ defineOperationDomain(imageContract);
