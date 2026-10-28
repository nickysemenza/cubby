import { relatednessContract } from "~/contracts/recommendations.contract";

import { defineOperationDomain } from "../operation-catalog";

export const relatedness =
  /* @__PURE__ */ defineOperationDomain(relatednessContract);
