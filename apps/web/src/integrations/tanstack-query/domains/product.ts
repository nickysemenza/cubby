import { productContract } from "~/contracts/product.contract";

import { defineOperationDomain } from "../operation-catalog";

export const product = /* @__PURE__ */ defineOperationDomain(productContract);
