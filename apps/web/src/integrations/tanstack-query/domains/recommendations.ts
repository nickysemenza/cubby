import { recommendationsContract } from "~/contracts/recommendations.contract";

import { defineOperationDomain } from "../operation-catalog";

export const recommendations = /* @__PURE__ */ defineOperationDomain(
  recommendationsContract,
);
