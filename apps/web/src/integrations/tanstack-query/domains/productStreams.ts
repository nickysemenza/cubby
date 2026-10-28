import { productStreamsContract } from "~/contracts/product.contract";

import { defineOperationDomain } from "../operation-catalog";

export const productStreams = /* @__PURE__ */ defineOperationDomain(
  productStreamsContract,
);
